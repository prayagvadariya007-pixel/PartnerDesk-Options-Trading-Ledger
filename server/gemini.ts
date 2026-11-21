import { GoogleGenAI, ThinkingLevel, Type } from '@google/genai';
import { round2 } from '../shared/calculations.ts';
import type { ExtractedOrderLeg } from '../shared/types.ts';

function getGeminiClient(): GoogleGenAI {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error('GEMINI_API_KEY is not configured in environment secrets.');
  }
  return new GoogleGenAI({
    apiKey,
    httpOptions: {
      timeout: 45000,
      headers: {
        'User-Agent': 'aistudio-build',
      },
    },
  });
}

export interface ScreenshotExtractionResult {
  orders: ExtractedOrderLeg[];
  tradingDateFound: boolean;
  notes: string;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseFriendlyGeminiError(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  if (
    raw.includes('503') ||
    raw.includes('504') ||
    raw.includes('UNAVAILABLE') ||
    raw.includes('DEADLINE_EXCEEDED') ||
    raw.includes('high demand')
  ) {
    return 'Vision OCR service is temporarily busy. Please click Retry OCR in a moment or add the order manually.';
  }
  if (raw.includes('429') || raw.includes('RESOURCE_EXHAUSTED')) {
    return 'Gemini API quota limit reached. Please try again shortly or check Settings > Secrets.';
  }
  if (raw.includes('API_KEY_INVALID') || raw.includes('403') || raw.includes('PERMISSION_DENIED')) {
    return 'Gemini API key is invalid or missing permissions. Please verify it in Settings > Secrets.';
  }
  return raw;
}

function extractJsonObject(rawText: string): string {
  let cleaned = rawText.trim();
  const fenceMatch = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(cleaned);
  if (fenceMatch) {
    cleaned = fenceMatch[1].trim();
  }
  const firstBrace = cleaned.indexOf('{');
  const lastBrace = cleaned.lastIndexOf('}');
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    return cleaned.slice(firstBrace, lastBrace + 1);
  }
  return cleaned || '{}';
}

export async function extractAngelOneScreenshot(params: {
  base64Data: string;
  mimeType: string;
}): Promise<ScreenshotExtractionResult> {
  const ai = getGeminiClient();

  const systemInstruction = `You are a precision financial OCR extractor for Indian stock market Options (CE/PE) screenshots from the Angel One app (Order Book, Trade Book, Executed Orders, or Positions).
Strictly follow these rules:
1. Extract every executed BUY and SELL option order visible in the screenshot. Ignore rejected/cancelled/pending orders unless clearly executed.
2. Separate EXPIRY DATE from TRADING DATE:
   - Expiry date is part of the option contract (e.g., "23 NOV 26", "23 November 2026", "27 Nov"). Normalize to YYYY-MM-DD.
   - Trading date is the date the order was executed (if shown on the screenshot header, timestamp, or order date column). If the trading date is NOT explicitly visible in the screenshot, return "" (empty string) for tradingDate and set tradingDateFound = false. NEVER copy expiryDate into tradingDate!
3. Quantity vs Lots:
   - Do NOT guess or hardcode NSE F&O lot sizes.
   - If the screenshot shows exact unit quantity (e.g., "650" or "650/650"), use that exact unit quantity.
   - If the screenshot shows lots (e.g., "1 lot") AND shows total amount and execution price, derive total unit quantity = Math.round(amount / executionPrice), and also populate "lots".
   - If total amount is visible (e.g. ₹2,177.50), extract it accurately. If only quantity and price are visible, compute amount = quantity * executionPrice.
4. Option Type must be strictly "CE" or "PE". Side must be strictly "BUY" or "SELL".
5. Never invent missing numbers. If a field cannot be read reliably, mention it in confidenceNotes.`;

  const responseSchema = {
    type: Type.OBJECT,
    properties: {
      tradingDateFound: {
        type: Type.BOOLEAN,
        description:
          'True only if the actual execution/trading date is explicitly visible in the screenshot (not the contract expiry date).',
      },
      notes: {
        type: Type.STRING,
        description: 'Any observations or uncertainties about unreadable fields.',
      },
      orders: {
        type: Type.ARRAY,
        items: {
          type: Type.OBJECT,
          properties: {
            stockName: {
              type: Type.STRING,
              description: 'Underlying stock or index name, e.g. HDFCBANK, NIFTY, BANKNIFTY.',
            },
            tradingSymbol: {
              type: Type.STRING,
              description: 'Full contract label/symbol shown on Angel One.',
            },
            expiryDate: {
              type: Type.STRING,
              description: 'Contract expiry date normalized to YYYY-MM-DD.',
            },
            strikePrice: {
              type: Type.NUMBER,
              description: 'Option strike price, e.g. 830.',
            },
            optionType: { type: Type.STRING, description: 'Strictly CE or PE.' },
            side: { type: Type.STRING, description: 'Strictly BUY or SELL.' },
            quantity: {
              type: Type.NUMBER,
              description:
                'Total units (shares/contracts, NOT lot count). Derive from amount / executionPrice if only lots + amount are shown.',
            },
            lots: { type: Type.NUMBER, description: 'Lot count if shown, or 0 if not shown.' },
            executionPrice: { type: Type.NUMBER, description: 'Executed price per unit in INR.' },
            amount: { type: Type.NUMBER, description: 'Total executed order value in INR.' },
            executionTime: {
              type: Type.STRING,
              description: 'Execution time string, e.g. 09:31 AM.',
            },
            tradingDate: {
              type: Type.STRING,
              description: 'Trading execution date in YYYY-MM-DD, or empty string if not visible.',
            },
            confidenceNotes: { type: Type.STRING, description: 'Any field-level note.' },
          },
          required: [
            'stockName',
            'tradingSymbol',
            'expiryDate',
            'strikePrice',
            'optionType',
            'side',
            'quantity',
            'executionPrice',
            'amount',
            'executionTime',
            'tradingDate',
          ],
        },
      },
    },
    required: ['tradingDateFound', 'notes', 'orders'],
  };

  const attempts: { model: string; useLowThinking: boolean; delayMs: number }[] = [
    { model: 'gemini-4-hydrogen', useLowThinking: true, delayMs: 0 },
    { model: 'gemini-3.1-flash-lite', useLowThinking: false, delayMs: 250 },
    { model: 'gemini-3.1-flash-lite', useLowThinking: false, delayMs: 1000 },
  ];

  let lastError: unknown = null;
  let responseText: string | undefined;

  for (const attempt of attempts) {
    if (attempt.delayMs > 0) {
      await sleep(attempt.delayMs);
    }
    try {
      const response = await ai.models.generateContent({
        model: attempt.model,
        contents: {
          parts: [
            {
              inlineData: {
                mimeType: params.mimeType,
                data: params.base64Data,
              },
            },
            {
              text: 'Extract all executed Angel One Options (CE/PE) order legs from this screenshot into structured JSON.',
            },
          ],
        },
        config: {
          systemInstruction,
          responseMimeType: 'application/json',
          responseSchema,
          ...(attempt.useLowThinking
            ? { thinkingConfig: { thinkingLevel: ThinkingLevel.LOW } }
            : {}),
        },
      });
      responseText = response.text;
      break;
    } catch (err) {
      lastError = err;
      const msg = err instanceof Error ? err.message : String(err);
      const retryable =
        msg.includes('503') ||
        msg.includes('504') ||
        msg.includes('UNAVAILABLE') ||
        msg.includes('DEADLINE_EXCEEDED') ||
        msg.includes('429') ||
        msg.includes('500') ||
        msg.includes('fetch') ||
        msg.includes('timeout') ||
        msg.includes('AbortError');
      if (!retryable) {
        throw new Error(parseFriendlyGeminiError(err));
      }
    }
  }

  if (responseText === undefined) {
    throw new Error(parseFriendlyGeminiError(lastError));
  }

  const jsonStr = extractJsonObject(responseText);
  const parsed = JSON.parse(jsonStr) as {
    tradingDateFound?: boolean;
    notes?: string;
    orders?: Array<Partial<ExtractedOrderLeg> & { lots?: number }>;
  };

  const orders: ExtractedOrderLeg[] = (parsed.orders || []).map((item) => {
    const price = Number(item.executionPrice || 0);
    let amount = Number(item.amount || 0);
    let quantity = Math.round(Number(item.quantity || 0));
    const lots = item.lots && Number(item.lots) > 0 ? Number(item.lots) : null;

    if (amount > 0 && price > 0) {
      const impliedQty = Math.round(amount / price);
      if (quantity <= 0 || (lots !== null && quantity === lots && impliedQty > lots)) {
        quantity = impliedQty;
      }
    } else if (quantity > 0 && price > 0 && amount <= 0) {
      amount = round2(quantity * price);
    }

    const optionType = String(item.optionType || 'CE').toUpperCase() === 'PE' ? 'PE' : 'CE';
    const side = String(item.side || 'BUY').toUpperCase() === 'SELL' ? 'SELL' : 'BUY';
    const stockName = String(item.stockName || '').trim().toUpperCase();
    const expiryDate = String(item.expiryDate || '').trim();
    const tradingDate = String(item.tradingDate || '').trim();

    return {
      stockName,
      tradingSymbol: String(
        item.tradingSymbol || `${stockName} ${item.strikePrice || ''} ${optionType}`,
      ).trim(),
      expiryDate,
      strikePrice: Number(item.strikePrice || 0),
      optionType,
      side,
      quantity,
      lots,
      executionPrice: price,
      amount: round2(amount),
      executionTime: String(item.executionTime || '').trim(),
      tradingDate:
        tradingDate && tradingDate !== expiryDate
          ? tradingDate
          : parsed.tradingDateFound
            ? tradingDate
            : '',
      confidenceNotes: item.confidenceNotes || undefined,
    };
  });

  const tradingDateFound = Boolean(
    parsed.tradingDateFound && orders.some((o) => o.tradingDate.length === 10),
  );

  return {
    orders,
    tradingDateFound,
    notes: parsed.notes || '',
  };
}
