import 'dotenv/config';
import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import type { NextFunction, Request, Response } from 'express';
import {
  addDeposit,
  checkDuplicateScreenshot,
  claimInitialPassword,
  deleteDeposit,
  deleteTradeGroup,
  exportServerBackupPayload,
  getAuthStatus,
  getChargeRates,
  getDashboardSummary,
  listAuditLogs,
  listDeposits,
  listTradeGroups,
  mergeServerBackupPayload,
  saveChargeRates,
  saveUploadedOrders,
  signSessionToken,
  updateSharedPassword,
  updateTradeGroupDetails,
  verifyPartnerPassword,
  verifySessionToken,
} from './server/db.ts';
import { extractAngelOneScreenshot } from './server/gemini.ts';
import type {
  ChargeRates,
  ExtractedOrderLeg,
  FundEntryType,
  OptionType,
  OrderSide,
  PartnerId,
} from './shared/types.ts';

interface AuthedRequest extends Request {
  partnerId?: PartnerId;
}

function normalizePartnerId(raw: unknown): PartnerId | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim().toLowerCase();
  if (trimmed === 'prayag') return 'Prayag';
  if (trimmed === 'raj') return 'Raj';
  return null;
}

function requireAuth(req: AuthedRequest, res: Response, next: NextFunction): void {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Authentication required.' });
    return;
  }
  const token = authHeader.slice('Bearer '.length).trim();
  const payload = verifySessionToken(token);
  if (!payload) {
    res.status(401).json({ error: 'Session expired or invalid. Please sign in again.' });
    return;
  }
  req.partnerId = payload.partnerId;
  next();
}

async function startServer() {
  const app = express();
  const PORT = 3000;

  app.use(express.json({ limit: '25mb' }));

  app.get('/api/health', (_req, res) => {
    res.json({ ok: true, storageMode: 'shared-server' });
  });

  // --- Auth Routes ---
  app.get('/api/auth/status', (_req, res) => {
    res.json(getAuthStatus());
  });

  app.post('/api/auth/setup', (req, res) => {
    const partnerId = normalizePartnerId(req.body?.partnerId ?? 'Prayag');
    const password = typeof req.body?.password === 'string' ? req.body.password : '';
    if (!partnerId) {
      res.status(400).json({ error: 'Select Prayag or Raj login ID.' });
      return;
    }
    if (password.length < 6 || password.length > 128) {
      res.status(400).json({ error: 'Password must be between 6 and 128 characters.' });
      return;
    }
    try {
      claimInitialPassword(password, partnerId);
      const token = signSessionToken(partnerId);
      res.status(201).json({ token, partnerId });
    } catch (err) {
      if (err instanceof Error && err.message === 'ALREADY_CONFIGURED') {
        res.status(409).json({ error: 'Partnership password is already configured. Please sign in.' });
        return;
      }
      res.status(500).json({ error: 'Failed to configure password.' });
    }
  });

  app.post('/api/auth/login', (req, res) => {
    const status = getAuthStatus();
    if (status.needsInitialSetup) {
      res.status(409).json({ error: 'Initial partnership password has not been set yet.' });
      return;
    }
    const partnerId = normalizePartnerId(req.body?.partnerId);
    const password = typeof req.body?.password === 'string' ? req.body.password : '';
    if (!partnerId) {
      res.status(400).json({ error: 'Enter a valid Login ID (Prayag or Raj).' });
      return;
    }
    if (!verifyPartnerPassword(password)) {
      res.status(401).json({ error: 'Invalid shared partnership password.' });
      return;
    }
    const token = signSessionToken(partnerId);
    res.json({ token, partnerId });
  });

  app.get('/api/auth/me', requireAuth, (req: AuthedRequest, res) => {
    res.json({ partnerId: req.partnerId });
  });

  app.post('/api/auth/password', requireAuth, (req: AuthedRequest, res) => {
    const currentPassword = typeof req.body?.currentPassword === 'string' ? req.body.currentPassword : '';
    const newPassword = typeof req.body?.newPassword === 'string' ? req.body.newPassword : '';
    if (newPassword.length < 6 || newPassword.length > 128) {
      res.status(400).json({ error: 'New password must be between 6 and 128 characters.' });
      return;
    }
    try {
      updateSharedPassword(currentPassword, newPassword, req.partnerId!);
      res.json({ ok: true });
    } catch (err) {
      if (err instanceof Error && err.message === 'ENV_PASSWORD_LOCKED') {
        res.status(400).json({
          error: 'Password is managed via the PARTNER_ACCESS_PASSWORD environment secret.',
        });
        return;
      }
      if (err instanceof Error && err.message === 'INVALID_CURRENT_PASSWORD') {
        res.status(401).json({ error: 'Current password is incorrect.' });
        return;
      }
      res.status(500).json({ error: 'Failed to update password.' });
    }
  });

  // --- Shared Website Ledger Routes (Same data for Prayag & Raj) ---
  app.get('/api/dashboard', requireAuth, (_req, res) => {
    res.json(getDashboardSummary());
  });

  app.get('/api/trades', requireAuth, (_req, res) => {
    res.json({
      trades: listTradeGroups(),
      rates: getChargeRates(),
    });
  });

  app.post('/api/trades/ocr', requireAuth, async (req: AuthedRequest, res) => {
    const dataUrl = typeof req.body?.imageDataUrl === 'string' ? req.body.imageDataUrl.trim() : '';
    const match = /^data:(image\/(?:png|jpeg|jpg|webp|gif|bmp))(?:;[^;]+)*;base64,([\s\S]+)$/i.exec(
      dataUrl,
    );
    if (!match) {
      res.status(400).json({ error: 'Please upload a valid PNG, JPG, or WEBP screenshot.' });
      return;
    }

    const { duplicate } = checkDuplicateScreenshot(dataUrl);
    if (duplicate) {
      res.status(409).json({
        error: `Duplicate screenshot detected (already uploaded on ${new Date(
          duplicate.uploadedAt,
        ).toLocaleString()} by ${duplicate.uploadedBy}).`,
      });
      return;
    }

    const mimeType = match[1].toLowerCase() === 'image/jpg' ? 'image/jpeg' : match[1].toLowerCase();
    const base64Data = match[2].replace(/\s+/g, '');

    try {
      const result = await extractAngelOneScreenshot({ base64Data, mimeType });
      res.json(result);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Screenshot recognition failed.';
      res.status(500).json({ error: msg });
    }
  });

  app.post('/api/trades/save', requireAuth, (req: AuthedRequest, res) => {
    const rawOrders = Array.isArray(req.body?.orders) ? req.body.orders : null;
    if (!rawOrders || rawOrders.length === 0) {
      res.status(400).json({ error: 'At least one order leg is required.' });
      return;
    }

    const screenshotDataUrl =
      typeof req.body?.screenshotDataUrl === 'string' ? req.body.screenshotDataUrl.trim() : null;
    if (
      screenshotDataUrl &&
      !/^data:image\/(?:png|jpeg|jpg|webp|gif|bmp)(?:;[^;]+)*;base64,[\s\S]+$/i.test(
        screenshotDataUrl,
      )
    ) {
      res.status(400).json({ error: 'Invalid screenshot image format.' });
      return;
    }

    const originalFilename =
      typeof req.body?.originalFilename === 'string' ? req.body.originalFilename.slice(0, 255) : null;

    const cleanOrders: ExtractedOrderLeg[] = [];
    for (let i = 0; i < rawOrders.length; i++) {
      const leg = rawOrders[i] as Record<string, unknown>;
      const stockName = typeof leg?.stockName === 'string' ? leg.stockName.trim() : '';
      const tradingDate = typeof leg?.tradingDate === 'string' ? leg.tradingDate.trim() : '';
      const expiryDate = typeof leg?.expiryDate === 'string' ? leg.expiryDate.trim() : '';
      const strikePrice = Number(leg?.strikePrice);
      const quantity = Math.round(Number(leg?.quantity));
      const executionPrice = Number(leg?.executionPrice);
      const amount = Number(leg?.amount);
      const optionType: OptionType = leg?.optionType === 'PE' ? 'PE' : 'CE';
      const side: OrderSide = leg?.side === 'SELL' ? 'SELL' : 'BUY';

      if (!stockName || !tradingDate || !expiryDate) {
        res.status(400).json({
          error: `Order row ${i + 1}: Stock name, trading date, and expiry date are required.`,
        });
        return;
      }
      if (!Number.isFinite(strikePrice) || strikePrice <= 0 || !Number.isFinite(quantity) || quantity <= 0 || !Number.isFinite(executionPrice) || executionPrice <= 0) {
        res.status(400).json({
          error: `Order row ${i + 1}: Strike price, quantity, and execution price must be positive.`,
        });
        return;
      }

      cleanOrders.push({
        stockName,
        tradingSymbol:
          typeof leg?.tradingSymbol === 'string' && leg.tradingSymbol.trim()
            ? leg.tradingSymbol.trim()
            : `${stockName} ${strikePrice} ${optionType}`,
        expiryDate,
        strikePrice,
        optionType,
        side,
        quantity,
        lots:
          leg?.lots !== null && leg?.lots !== undefined && Number(leg.lots) > 0
            ? Number(leg.lots)
            : null,
        executionPrice,
        amount: Number.isFinite(amount) && amount > 0 ? amount : quantity * executionPrice,
        executionTime:
          typeof leg?.executionTime === 'string' && leg.executionTime.trim()
            ? leg.executionTime.trim()
            : '09:15 AM',
        tradingDate,
      });
    }

    try {
      const saved = saveUploadedOrders({
        actor: req.partnerId!,
        screenshotDataUrl,
        originalFilename,
        orders: cleanOrders,
      });
      res.status(201).json(saved);
    } catch (err) {
      if (err instanceof Error && err.message.startsWith('DUPLICATE_SCREENSHOT:')) {
        const [, uploadedAt, uploadedBy] = err.message.split(':');
        res.status(409).json({
          error: `Duplicate screenshot detected (already uploaded on ${new Date(
            uploadedAt,
          ).toLocaleString()} by ${uploadedBy}).`,
        });
        return;
      }
      res.status(500).json({ error: err instanceof Error ? err.message : 'Failed to save orders.' });
    }
  });

  app.patch('/api/trades/:id', requireAuth, (req: AuthedRequest, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      res.status(400).json({ error: 'Invalid trade ID.' });
      return;
    }
    try {
      const updated = updateTradeGroupDetails(id, req.partnerId!, req.body || {});
      if (!updated) {
        res.status(404).json({ error: 'Trade not found.' });
        return;
      }
      res.json({ trade: updated });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : 'Failed to update trade.' });
    }
  });

  app.delete('/api/trades/:id', requireAuth, (req: AuthedRequest, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      res.status(400).json({ error: 'Invalid trade ID.' });
      return;
    }
    const deleted = deleteTradeGroup(id, req.partnerId!);
    if (!deleted) {
      res.status(404).json({ error: 'Trade not found.' });
      return;
    }
    res.json({ ok: true });
  });

  app.get('/api/deposits', requireAuth, (_req, res) => {
    res.json({
      deposits: listDeposits(),
      summary: getDashboardSummary().summary,
    });
  });

  app.post('/api/deposits', requireAuth, (req: AuthedRequest, res) => {
    const partner = normalizePartnerId(req.body?.partner);
    const entryType: FundEntryType = req.body?.entryType === 'WITHDRAWAL' ? 'WITHDRAWAL' : 'DEPOSIT';
    const amount = Number(req.body?.amount);
    const depositDate = typeof req.body?.depositDate === 'string' ? req.body.depositDate.trim() : '';
    const referenceNote =
      typeof req.body?.referenceNote === 'string' ? req.body.referenceNote.trim() : null;

    if (!partner) {
      res.status(400).json({ error: 'Partner must be Prayag or Raj.' });
      return;
    }
    if (!Number.isFinite(amount) || amount <= 0) {
      res.status(400).json({ error: 'Amount must be a positive number.' });
      return;
    }
    if (!depositDate) {
      res.status(400).json({ error: 'Date is required.' });
      return;
    }

    try {
      const deposit = addDeposit({
        partner,
        entryType,
        amount,
        depositDate,
        referenceNote,
        actor: req.partnerId!,
      });
      res.status(201).json({ deposit });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : 'Failed to record fund entry.' });
    }
  });

  app.delete('/api/deposits/:id', requireAuth, (req: AuthedRequest, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      res.status(400).json({ error: 'Invalid fund entry ID.' });
      return;
    }
    const deleted = deleteDeposit(id, req.partnerId!);
    if (!deleted) {
      res.status(404).json({ error: 'Fund entry not found.' });
      return;
    }
    res.json({ ok: true });
  });

  app.get('/api/settings/rates', requireAuth, (_req, res) => {
    res.json({ rates: getChargeRates() });
  });

  app.put('/api/settings/rates', requireAuth, (req: AuthedRequest, res) => {
    const fields: (keyof ChargeRates)[] = [
      'brokeragePerOrder',
      'sttSellPct',
      'exchangeTxnPct',
      'ipftPct',
      'sebiPct',
      'stampDutyBuyPct',
      'gstPct',
    ];
    for (const f of fields) {
      const val = Number(req.body?.[f]);
      if (!Number.isFinite(val) || val < 0) {
        res.status(400).json({ error: `Invalid charge rate value for ${f}.` });
        return;
      }
    }
    const rates = saveChargeRates(
      {
        brokeragePerOrder: Number(req.body.brokeragePerOrder),
        sttSellPct: Number(req.body.sttSellPct),
        exchangeTxnPct: Number(req.body.exchangeTxnPct),
        ipftPct: Number(req.body.ipftPct),
        sebiPct: Number(req.body.sebiPct),
        stampDutyBuyPct: Number(req.body.stampDutyBuyPct),
        gstPct: Number(req.body.gstPct),
      },
      req.partnerId!,
      Boolean(req.body?.recalculateExisting),
    );
    res.json({ rates });
  });

  app.get('/api/audit-logs', requireAuth, (_req, res) => {
    res.json({ logs: listAuditLogs(500) });
  });

  // --- Shared Backup / Sync Mirror Endpoints ---
  app.get('/api/local-bootstrap', requireAuth, (_req, res) => {
    res.json({
      trades: listTradeGroups(),
      deposits: listDeposits(),
      rates: getChargeRates(),
      auditLogs: listAuditLogs(500),
    });
  });

  app.get('/api/sync/backup', requireAuth, (_req, res) => {
    res.json(exportServerBackupPayload());
  });

  app.post('/api/sync/merge', requireAuth, (req: AuthedRequest, res) => {
    const body = req.body;
    if (!body || typeof body !== 'object') {
      res.status(400).json({ error: 'Invalid backup payload.' });
      return;
    }
    try {
      const result = mergeServerBackupPayload(body, req.partnerId!);
      res.json(result);
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : 'Failed to merge backup.' });
    }
  });

  // --- Vite Middleware / Production Static Serving ---
  const distDir = path.resolve(process.cwd(), 'dist');
  const isProd = process.env.NODE_ENV === 'production' && fs.existsSync(distDir);

  if (!isProd) {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    app.use(express.static(distDir));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distDir, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`PartnerDesk server running on http://0.0.0.0:${PORT}`);
  });
}

startServer();
