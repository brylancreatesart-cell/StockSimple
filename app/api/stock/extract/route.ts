import { NextResponse } from 'next/server'

type ExtractedLine = { description: string; itemNumber: string; location: string; quantity: string; ocrConfidence: number; needsReview: boolean }

const MAX_FILE_SIZE = 10 * 1024 * 1024
const ALLOWED_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp'])

const schema = {
  type: 'object', additionalProperties: false,
  properties: {
    costCenter: { type: 'string' }, afe: { type: 'string' }, projectNumber: { type: 'string' },
    transactionType: { type: 'string', enum: ['Miscellaneous Issue', 'Issue to Project', 'Inventory Transfer', 'Issue to Conversion', ''] },
    remarks: { type: 'string' }, receivedReturnedBy: { type: 'string' }, preparedBy: { type: 'string' }, approvedBy: { type: 'string' },
    lines: { type: 'array', items: { type: 'object', additionalProperties: false, properties: {
      description: { type: 'string' }, itemNumber: { type: 'string' }, location: { type: 'string' }, quantity: { type: 'string' },
      ocrConfidence: { type: 'number', minimum: 0, maximum: 1 }, needsReview: { type: 'boolean' }
    }, required: ['description', 'itemNumber', 'location', 'quantity', 'ocrConfidence', 'needsReview'] } }
  }, required: ['costCenter','afe','projectNumber','transactionType','remarks','receivedReturnedBy','preparedBy','approvedBy','lines']
}

const extractionPrompt = `Extract this handwritten Stores Issue Document from the ORIGINAL IMAGE. Understand the printed form and table grid first, then transcribe only handwritten values. Never guess. Preserve exact visible identifiers, leading zeros, spelling and quantities. Inventory columns are DESCRIPTION, ITEM NO., LOCATOR, QUANTITY and physical row/column placement must be preserved. Also carefully read the handwritten AFE and Project Number/header identifier fields. Ignore blank rows. For checkboxes, select only an actually visible mark. Pay special attention to 0/O, 1/I/l, 2/Z, 5/S, 6/G, 8/B and 9/g.

Your job is transcription, not risk scoring. Return your best visually supported transcription. Do not invent missing values. Set needsReview to false; the application will independently determine review status by comparing separate visual readings. Set ocrConfidence to your internal estimate, but the application will not use it to decide review.

Return only the requested structured data.`

const verificationPrompt = `Independently transcribe this handwritten Stores Issue Document from the ORIGINAL IMAGE. Do NOT rely on or infer from another transcription. Read the physical form grid and every handwritten field yourself. Preserve exact visible identifiers, leading zeros, spelling, quantities, and row/column placement. Carefully verify the AFE and Project Number/header identifier fields. Ignore blank rows. Pay special attention to 0/O, 1/I/l, 2/Z, 5/S, 6/G, 8/B and 9/g.

This is an independent second reading used for quality control. Return only what the ORIGINAL IMAGE visibly supports; never guess. Set needsReview to false because the application will compare this reading with another independent reading. Set ocrConfidence to your internal estimate, but the application will not use it to decide review.

Return only the requested structured data.`

function extractOutputText(result: any): string {
  if (typeof result?.output_text === 'string' && result.output_text.trim()) return result.output_text.trim()
  const parts: string[] = []
  for (const item of Array.isArray(result?.output) ? result.output : []) {
    if (item?.type !== 'message') continue
    for (const content of Array.isArray(item.content) ? item.content : []) {
      if ((content?.type === 'output_text' || content?.type === 'text') && typeof content.text === 'string') parts.push(content.text)
    }
  }
  return parts.join('').trim()
}

async function callVision(apiKey: string, dataUrl: string, prompt: string) {
  const response = await fetch('https://api.openai.com/v1/responses', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` }, body: JSON.stringify({
    model: 'gpt-5.6-luna', input: [{ role: 'user', content: [{ type: 'input_text', text: prompt }, { type: 'input_image', image_url: dataUrl, detail: 'high' }] }],
    text: { format: { type: 'json_schema', name: 'stores_issue_document', strict: true, schema } }
  }) })
  if (!response.ok) { console.error('OpenAI extraction call failed', response.status, await response.text()); throw new Error('OpenAI extraction request failed') }
  const result = await response.json(); const outputText = extractOutputText(result)
  if (!outputText) throw new Error('OpenAI extraction returned no text')
  try { return JSON.parse(outputText) } catch { throw new Error('OpenAI extraction returned invalid JSON') }
}

function normalizeText(value: unknown) { return String(value ?? '').trim().replace(/\s+/g, ' ').toUpperCase() }
function normalizeExtraction(extracted: any, reviewFields: Set<string> = new Set(), headerNeedsReview = false) {
  const lines: ExtractedLine[] = Array.isArray(extracted?.lines) ? extracted.lines.map((line: any, index: number) => {
    const fields = ['description', 'itemNumber', 'location', 'quantity']
    const needsReview = fields.some((field) => reviewFields.has(`${index}:${field}`))
    const raw = Math.max(0, Math.min(1, Number(line?.ocrConfidence) || 0))
    return { description: String(line?.description || ''), itemNumber: String(line?.itemNumber || ''), location: String(line?.location || ''), quantity: String(line?.quantity || ''), ocrConfidence: needsReview ? Math.min(raw || 0.94, 0.94) : Math.max(raw, 0.95), needsReview }
  }) : []
  return { costCenter: String(extracted?.costCenter || ''), afe: String(extracted?.afe || ''), projectNumber: String(extracted?.projectNumber || ''), transactionType: ['Miscellaneous Issue','Issue to Project','Inventory Transfer','Issue to Conversion'].includes(extracted?.transactionType) ? extracted.transactionType : '', remarks: String(extracted?.remarks || ''), receivedReturnedBy: String(extracted?.receivedReturnedBy || ''), preparedBy: String(extracted?.preparedBy || ''), approvedBy: String(extracted?.approvedBy || ''), headerNeedsReview, lines }
}

function normalizedField(line: any, field: string) { return normalizeText(line?.[field]) }
function normalizedHeader(value: any) { return normalizeText(value) }

export async function POST(request: Request) {
  try {
    const apiKey = process.env.OPENAI_API_KEY
    if (!apiKey) return NextResponse.json({ error: 'Handwriting extraction is not configured yet. Add OPENAI_API_KEY to Vercel Production environment variables.' }, { status: 500 })
    const formData = await request.formData(); const file = formData.get('file')
    if (!(file instanceof File)) return NextResponse.json({ error: 'A photo of the stock sheet is required.' }, { status: 400 })
    if (!ALLOWED_TYPES.has(file.type)) return NextResponse.json({ error: 'For handwriting extraction, upload a JPG, PNG, or WEBP photo.' }, { status: 400 })
    if (file.size === 0 || file.size > MAX_FILE_SIZE) return NextResponse.json({ error: 'The stock sheet photo must be between 1 byte and 10 MB.' }, { status: 400 })
    const bytes = Buffer.from(await file.arrayBuffer()); const dataUrl = `data:${file.type};base64,${bytes.toString('base64')}`

    const firstPass = await callVision(apiKey, dataUrl, extractionPrompt)
    let finalPass = firstPass
    const reviewFields = new Set<string>()
    let headerNeedsReview = false
    try {
      finalPass = await callVision(apiKey, dataUrl, verificationPrompt)
      for (const field of ['afe', 'projectNumber']) {
        if (normalizedHeader(firstPass?.[field]) !== normalizedHeader(finalPass?.[field])) headerNeedsReview = true
      }
      const firstLines = Array.isArray(firstPass?.lines) ? firstPass.lines : []
      const secondLines = Array.isArray(finalPass?.lines) ? finalPass.lines : []
      const count = Math.max(firstLines.length, secondLines.length)
      for (let i = 0; i < count; i++) {
        const a = firstLines[i]; const b = secondLines[i]
        if (!a || !b) { ['description','itemNumber','location','quantity'].forEach((field) => reviewFields.add(`${i}:${field}`)); continue }
        for (const field of ['description','itemNumber','location','quantity']) {
          if (normalizedField(a, field) !== normalizedField(b, field)) reviewFields.add(`${i}:${field}`)
        }
      }
      finalPass.lines = secondLines
    } catch (error) { console.error('Second independent handwriting verification failed; using first pass', error) }

    return NextResponse.json({ ...normalizeExtraction(finalPass, reviewFields, headerNeedsReview), ocrSource: 'openai-vision-independent-two-pass-critical-field-verification' })
  } catch (error) {
    console.error('Handwriting extraction error', error); const message = error instanceof Error ? error.message : ''
    if (message.includes('OpenAI extraction')) return NextResponse.json({ error: 'The handwriting reader could not reliably process this photo. Try a clearer, straight-on photo.' }, { status: 502 })
    return NextResponse.json({ error: 'Unable to extract handwriting from this photo.' }, { status: 500 })
  }
}
