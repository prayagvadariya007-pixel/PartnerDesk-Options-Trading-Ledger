import express from 'express';
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
  getStorageInfo,
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
} from './db.ts';
import { extractAngelOneScreenshot } from './gemini.ts';
import type {
  ChargeRates,
  ExtractedOrderLeg,
  FundEntryType,
  OptionType,
  OrderSide,
  PartnerId,
} from '../shared/types.ts';

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

function asyncHandler(
  fn: (req: AuthedRequest, res: Response, next: NextFunction) => Promise<void>,
) {
  return (req: AuthedRequest, res: Response, next: NextFunction) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
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

export function createApiApp(): express.Express {
  const app = express();
  app.set('trust proxy', 1);
  app.use(express.json({ limit: '25mb' }));

  app.get('/api/health', (_req, res) => {
    const storage = getStorageInfo();
    res.json({
      ok: true,
      storageMode: 'shared-server',
      dbEngine: storage.engine,
      persistent: storage.persistent,
    });
  });

  // --- Auth Routes ---
  app.get(
    '/api/auth/status',
    asyncHandler(async (_req, res) => {
      res.json(await getAuthStatus());
    }),
  );

  app.post(
    '/api/auth/setup',
    asyncHandler(async (req, res) => {
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
        await claimInitialPassword(password, partnerId);
        const token = signSessionToken(partnerId);
        res.status(201).json({ token, partnerId });
      } catch (err) {
        if (err instanceof Error && err.message === 'ALREADY_CONFIGURED') {
          res.status(409).json({
            error: 'Partnership password is already configured. Please sign in.',
          });
          return;
        }
        throw err;
      }
    }),
  );

  app.post(
    '/api/auth/login',
    asyncHandler(async (req, res) => {
      const status = await getAuthStatus();
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
      if (!(await verifyPartnerPassword(password))) {
        res.status(401).json({ error: 'Invalid shared partnership password.' });
        return;
      }
      const token = signSessionToken(partnerId);
      res.json({ token, partnerId });
    }),
  );

  app.get('/api/auth/me', requireAuth, (req: AuthedRequest, res) => {
    res.json({ partnerId: req.partnerId });
  });

  app.post(
    '/api/auth/password',
    requireAuth,
    asyncHandler(async (req: AuthedRequest, res) => {
      const currentPassword =
        typeof req.body?.currentPassword === 'string' ? req.body.currentPassword : '';
      const newPassword = typeof req.body?.newPassword === 'string' ? req.body.newPassword : '';
      if (newPassword.length < 6 || newPassword.length > 128) {
        res.status(400).json({ error: 'New password must be between 6 and 128 characters.' });
        return;
      }
      try {
        await updateSharedPassword(currentPassword, newPassword, req.partnerId!);
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
        throw err;
      }
    }),
  );

  // --- Shared Website Ledger Routes (Same data for Prayag & Raj) ---
  app.get(
    '/api/dashboard',
    requireAuth,
    asyncHandler(async (_req, res) => {
      res.json(await getDashboardSummary());
    }),
  );

  app.get(
    '/api/trades',
    requireAuth,
    asyncHandler(async (_req, res) => {
      const [trades, rates] = await Promise.all([listTradeGroups(), getChargeRates()]);
      res.json({ trades, rates });
    }),
  );

  app.post(
    '/api/trades/ocr',
    requireAuth,
    asyncHandler(async (req: AuthedRequest, res) => {
      const dataUrl =
        typeof req.body?.imageDataUrl === 'string' ? req.body.imageDataUrl.trim() : '';
      const match =
        /^data:(image\/(?:png|jpeg|jpg|webp|gif|bmp))(?:;[^;]+)*;base64,([\s\S]+)$/i.exec(dataUrl);
      if (!match) {
        res.status(400).json({ error: 'Please upload a valid PNG, JPG, or WEBP screenshot.' });
        return;
      }

      const { duplicate } = await checkDuplicateScreenshot(dataUrl);
      if (duplicate) {
        res.status(409).json({
          error: `Duplicate screenshot detected (already uploaded on ${new Date(
            duplicate.uploadedAt,
          ).toLocaleString()} by ${duplicate.uploadedBy}).`,
        });
        return;
      }

      const mimeType =
        match[1].toLowerCase() === 'image/jpg' ? 'image/jpeg' : match[1].toLowerCase();
      const base64Data = match[2].replace(/\s+/g, '');

      try {
        const result = await extractAngelOneScreenshot({ base64Data, mimeType });
        res.json(result);
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Screenshot recognition failed.';
        res.status(500).json({ error: msg });
      }
    }),
  );

  app.post(
    '/api/trades/save',
    requireAuth,
    asyncHandler(async (req: AuthedRequest, res) => {
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
        typeof req.body?.originalFilename === 'string'
          ? req.body.originalFilename.slice(0, 255)
          : null;

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
        if (
          !Number.isFinite(strikePrice) ||
          strikePrice <= 0 ||
          !Number.isFinite(quantity) ||
          quantity <= 0 ||
          !Number.isFinite(executionPrice) ||
          executionPrice <= 0
        ) {
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
        const saved = await saveUploadedOrders({
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
        throw err;
      }
    }),
  );

  app.patch(
    '/api/trades/:id',
    requireAuth,
    asyncHandler(async (req: AuthedRequest, res) => {
      const id = Number(req.params.id);
      if (!Number.isInteger(id) || id <= 0) {
        res.status(400).json({ error: 'Invalid trade ID.' });
        return;
      }
      try {
        const updated = await updateTradeGroupDetails(id, req.partnerId!, req.body || {});
        if (!updated) {
          res.status(404).json({ error: 'Trade not found.' });
          return;
        }
        res.json({ trade: updated });
      } catch (err) {
        res.status(400).json({
          error: err instanceof Error ? err.message : 'Failed to update trade.',
        });
      }
    }),
  );

  app.delete(
    '/api/trades/:id',
    requireAuth,
    asyncHandler(async (req: AuthedRequest, res) => {
      const id = Number(req.params.id);
      if (!Number.isInteger(id) || id <= 0) {
        res.status(400).json({ error: 'Invalid trade ID.' });
        return;
      }
      const deleted = await deleteTradeGroup(id, req.partnerId!);
      if (!deleted) {
        res.status(404).json({ error: 'Trade not found.' });
        return;
      }
      res.json({ ok: true });
    }),
  );

  app.get(
    '/api/deposits',
    requireAuth,
    asyncHandler(async (_req, res) => {
      const [deposits, dashboard] = await Promise.all([listDeposits(), getDashboardSummary()]);
      res.json({
        deposits,
        summary: dashboard.summary,
      });
    }),
  );

  app.post(
    '/api/deposits',
    requireAuth,
    asyncHandler(async (req: AuthedRequest, res) => {
      const partner = normalizePartnerId(req.body?.partner);
      const entryType: FundEntryType =
        req.body?.entryType === 'WITHDRAWAL' ? 'WITHDRAWAL' : 'DEPOSIT';
      const amount = Number(req.body?.amount);
      const depositDate =
        typeof req.body?.depositDate === 'string' ? req.body.depositDate.trim() : '';
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
        const deposit = await addDeposit({
          partner,
          entryType,
          amount,
          depositDate,
          referenceNote,
          actor: req.partnerId!,
        });
        res.status(201).json({ deposit });
      } catch (err) {
        res.status(400).json({
          error: err instanceof Error ? err.message : 'Failed to record fund entry.',
        });
      }
    }),
  );

  app.delete(
    '/api/deposits/:id',
    requireAuth,
    asyncHandler(async (req: AuthedRequest, res) => {
      const id = Number(req.params.id);
      if (!Number.isInteger(id) || id <= 0) {
        res.status(400).json({ error: 'Invalid fund entry ID.' });
        return;
      }
      const deleted = await deleteDeposit(id, req.partnerId!);
      if (!deleted) {
        res.status(404).json({ error: 'Fund entry not found.' });
        return;
      }
      res.json({ ok: true });
    }),
  );

  app.get(
    '/api/settings/rates',
    requireAuth,
    asyncHandler(async (_req, res) => {
      res.json({ rates: await getChargeRates() });
    }),
  );

  app.put(
    '/api/settings/rates',
    requireAuth,
    asyncHandler(async (req: AuthedRequest, res) => {
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
      const rates = await saveChargeRates(
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
    }),
  );

  app.get(
    '/api/audit-logs',
    requireAuth,
    asyncHandler(async (_req, res) => {
      res.json({ logs: await listAuditLogs(500) });
    }),
  );

  // --- Shared Backup / Sync Mirror Endpoints ---
  app.get(
    '/api/local-bootstrap',
    requireAuth,
    asyncHandler(async (_req, res) => {
      const [trades, deposits, rates, auditLogs] = await Promise.all([
        listTradeGroups(),
        listDeposits(),
        getChargeRates(),
        listAuditLogs(500),
      ]);
      res.json({ trades, deposits, rates, auditLogs });
    }),
  );

  app.get(
    '/api/sync/backup',
    requireAuth,
    asyncHandler(async (_req, res) => {
      res.json(await exportServerBackupPayload());
    }),
  );

  app.post(
    '/api/sync/merge',
    requireAuth,
    asyncHandler(async (req: AuthedRequest, res) => {
      const body = req.body;
      if (!body || typeof body !== 'object') {
        res.status(400).json({ error: 'Invalid backup payload.' });
        return;
      }
      try {
        const result = await mergeServerBackupPayload(body, req.partnerId!);
        res.json(result);
      } catch (err) {
        res.status(400).json({
          error: err instanceof Error ? err.message : 'Failed to merge backup.',
        });
      }
    }),
  );

  app.use('/api', (err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const message = err instanceof Error ? err.message : 'Internal server error.';
    console.error('[API Error]', err);
    if (!res.headersSent) {
      res.status(500).json({ error: message });
    }
  });

  return app;
}
