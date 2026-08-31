import { NextResponse } from 'next/server'

type OcrLine = { description: string; itemNumber: string; location: string; quantity: string; confidence: number; needsReview: boolean }

const schema = {
  type: 'object', additionalProperties: false,
  properties: {
    company: { type: 'string' }, project: { type: 'string' }, costCenter: { type: 'string' }, afe: { type: 'string' },
    transactionType: { type: 'string', enum: ['', 'Miscellaneous Issue', 'Issue to Project', 'Inventory Transfer', 'Issue to Conversion'] },
    notes: { type: 'string' }, takenBy: { type: 'string' }, preparedBy: { type: 'string' }, approvedBy: { type: 'string' },
    lines: { type: 'array', items: { type: 'object', additionalProperties: false, properties: {
      description: { type: 'string' }, itemNumber: { type: 'string' }, location: { type: 'string' }, quantity: { type: 'string' },
      confidence: { type: 'number' }, needsReview: { type: 'boolean' },
    }, required: ['description','itemNumber','location','quantity','confidence','needsReview'] } },
  },
  required: ['company','project','costCenter','afe','transactionType','notes','takenBy','preparedBy','approvedBy','lines'],
} as const

export async function POST(request: Request) {
  const apiKey = process.env.OPENAI_API_KEY
  if (!apiKey) return NextResponse.json({ error: 'OCR is not configured yet. Add OPENAI_API_KEY to the Vercel Production environment variables.', code: 'OCR_NOT_CONFIGURED' }, { status: 503 })
  const form = await request.formData()
  const file = form.get('file')
  if (!(file instanceof File)) return NextResponse.json({ error: 'Please provide an image of the stock sheet.' }, { status: 400 })
  if (!file.type.startsWith('image/')) return NextResponse.json({ error: 'For handwriting recognition, upload a JPG, PNG, or WebP photo.' }, { status: 400 })
  if (file.size > 15 * 1024 * 1024) return NextResponse.json({ error: 'Image is too large. Please use a photo under 15 MB.' }, { status: 400 })
  const bytes = Buffer.from(await file.arrayBuffer())
  const dataUrl = `data:${file.type};base64,${bytes.toString('base64')}`
  const prompt = `Extract handwriting from this standardized STORES ISSUE DOCUMENT. Read handwritten content, not printed labels. Never invent missing values. Fixed layout: COST CENTER and AFE at top; transaction type is one of Miscellaneous Issue, Issue to Project, Inventory Transfer, Issue to Conversion; main grid columns are DESCRIPTION, ITEM NO., LOCATOR, QUANTITY; bottom fields are REMARKS/NOTES, RECEIVED/RETURNED BY, PREPARED BY, APPROVED. Map handwriting to the correct field/row. Ignore printed labels and blank ruled lines. Empty string means blank or unreadable. For every inventory line, confidence is 0 to 1; set needsReview true below 0.85 or when ambiguous.`
  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST', headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: process.env.OPENAI_VISION_MODEL || 'gpt-4.1-mini', temperature: 0,
      response_format: { type: 'json_schema', json_schema: { name: 'stores_issue_document', strict: true, schema } },
      messages: [ { role: 'system', content: 'You are a careful document-understanding system. Accuracy is more important than filling every field.' },
        { role: 'user', content: [{ type: 'text', text: prompt }, { type: 'image_url', image_url: { url: dataUrl, detail: 'high' } }] } ] })
  })
  if (!response.ok) { const detail = await response.text().catch(() => ''); console.error('OCR provider error', response.status, detail.slice(0,500)); return NextResponse.json({ error: 'The handwriting reader could not process this image. Please try a clearer photo.' }, { status: 502 }) }
  const payload = await response.json(); const content = payload?.choices?.[0]?.message?.content
  if (!content) return NextResponse.json({ error: 'The handwriting reader returned no extracted data.' }, { status: 502 })
  try { return NextResponse.json({ ...JSON.parse(content), ocrSource: 'openai-vision', ocrModel: process.env.OPENAI_VISION_MODEL || 'gpt-4.1-mini' }) }
  catch { return NextResponse.json({ error: 'The handwriting reader returned invalid structured data.' }, { status: 502 }) }
}
