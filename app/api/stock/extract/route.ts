import { NextResponse } from 'next/server'

type ExtractedLine = {
  description: string
  itemNumber: string
  location: string
  quantity: string
  ocrConfidence: number
  needsReview: boolean
}

const MAX_FILE_SIZE = 10 * 1024 * 1024
const ALLOWED_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp'])

const schema = {
  type: 'object', additionalProperties: false,
  properties: {
    costCenter: { type: 'string' }, afe: { type: 'string' },
    transactionType: { type: 'string', enum: ['Miscellaneous Issue', 'Issue to Project', 'Inventory Transfer', 'Issue to Conversion', ''] },
    remarks: { type: 'string' }, receivedReturnedBy: { type: 'string' }, preparedBy: { type: 'string' }, approvedBy: { type: 'string' },
    lines: { type: 'array', items: { type: 'object', additionalProperties: false, properties: {
      description: { type: 'string' }, itemNumber: { type: 'string' }, location: { type: 'string' }, quantity: { type: 'string' },
      ocrConfidence: { type: 'number', minimum: 0, maximum: 1 }, needsReview: { type: 'boolean' }
    }, required: ['description', 'itemNumber', 'location', 'quantity', 'ocrConfidence', 'needsReview'] } }
  }, required: ['costCenter','afe','transactionType','remarks','receivedReturnedBy','preparedBy','approvedBy','lines']
}

const basePrompt = `Extract this handwritten Stores Issue Document. Understand the printed form and table grid first, then transcribe only handwritten values. Never guess. Preserve exact visible identifiers, leading zeros, spelling and quantities. Inventory columns are DESCRIPTION, ITEM NO., LOCATOR, QUANTITY and physical row/column placement must be preserved. Ignore blank rows. For checkboxes, select only an actually visible mark. Pay special attention to 0/O, 1/I/l, 2/Z, 5/S, 6/G, 8/B and 9/g.

Do not use a numeric confidence score to decide review. For this first pass, needsReview should identify only a concrete visual problem: ambiguous character, incomplete handwriting, blur/occlusion, crossed-out content, or uncertain row/column placement. Clearly readable handwriting in the correct cell should be false. Return your best transcription and do not invent missing values.

Return only the requested structured data.`

const verificationPrompt = `Quality-control the handwritten Stores Issue Document against the ORIGINAL IMAGE. Independently verify every field and inventory row, correcting the draft only when the image supports it. Never guess. Preserve physical row/column placement, exact identifiers, leading zeros and visible quantities. Check 0/O, 1/I/l, 2/Z, 5/S, 6/G, 8/B and 9/g.

For this verification pass, needsReview should be true ONLY if the ORIGINAL IMAGE contains a concrete visual problem that a human must resolve: ambiguous characters, incomplete handwriting, blur/occlusion, crossed-out content, or uncertain physical row/column placement. Clearly readable, complete handwriting in the correct cell must be false. Ignore generic uncertainty. Do not mark a line for review merely because the model is not mathematically certain.

Return only the corrected structured data matching the schema.`

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

async function callVision(apiKey: string, dataUrl: string, prompt: string, draft?: string) {
  const inputText = draft ? `${prompt}\n\nFIRST-PASS DRAFT TO AUDIT:\n${draft}` : prompt
  const response = await fetch('https://api.openai.com/v1/responses', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` }, body: JSON.stringify({
    model: 'gpt-5.6-luna', input: [{ role: 'user', content: [{ type: 'input_text', text: inputText }, { type: 'input_image', image_url: dataUrl, detail: 'high' }] }],
    text: { format: { type: 'json_schema', name: 'stores_issue_document', strict: true, schema } }
  }) })
  if (!response.ok) { console.error('OpenAI extraction call failed', response.status, await response.text()); throw new Error('OpenAI extraction request failed') }
  const result = await response.json(); const outputText = extractOutputText(result)
  if (!outputText) throw new Error('OpenAI extraction returned no text')
  try { return JSON.parse(outputText) } catch { throw new Error('OpenAI extraction returned invalid JSON') }
}

function normalizeText(value: unknown) { return String(value ?? '').trim().replace(/\s+/g, ' ').toUpperCase() }
function normalizeExtraction(extracted: any, reviewOverrides: boolean[] = []) {
  const lines: ExtractedLine[] = Array.isArray(extracted?.lines) ? extracted.lines.map((line: ExtractedLine, index: number) => {
    const needsReview = reviewOverrides[index] ?? Boolean(line?.needsReview)
    const raw = Math.max(0, Math.min(1, Number(line?.ocrConfidence) || 0))
    return {
      description: String(line?.description || ''), itemNumber: String(line?.itemNumber || ''), location: String(line?.location || ''), quantity: String(line?.quantity || ''),
      ocrConfidence: needsReview ? Math.min(raw || 0.94, 0.94) : Math.max(raw, 0.95), needsReview
    }
  }) : []
  return { costCenter: String(extracted?.costCenter || ''), afe: String(extracted?.afe || ''), transactionType: ['Miscellaneous Issue','Issue to Project','Inventory Transfer','Issue to Conversion'].includes(extracted?.transactionType) ? extracted.transactionType : '', remarks: String(extracted?.remarks || ''), receivedReturnedBy: String(extracted?.receivedReturnedBy || ''), preparedBy: String(extracted?.preparedBy || ''), approvedBy: String(extracted?.approvedBy || ''), lines }
}

function lineSignature(line: any) {
  return [line?.description, line?.itemNumber, line?.location, line?.quantity].map(normalizeText).join('|')
}

export async function POST(request: Request) {
  try {
    const apiKey = process.env.OPENAI_API_KEY
    if (!apiKey) return NextResponse.json({ error: 'Handwriting extraction is not configured yet. Add OPENAI_API_KEY to Vercel Production environment variables.' }, { status: 500 })
    const formData = await request.formData(); const file = formData.get('file')
    if (!(file instanceof File)) return NextResponse.json({ error: 'A photo of the stock sheet is required.' }, { status: 400 })
    if (!ALLOWED_TYPES.has(file.type)) return NextResponse.json({ error: 'For handwriting extraction, upload a JPG, PNG, or WEBP photo.' }, { status: 400 })
    if (file.size === 0 || file.size > MAX_FILE_SIZE) return NextResponse.json({ error: 'The stock sheet photo must be between 1 byte and 10 MB.' }, { status: 400 })
    const bytes = Buffer.from(await file.arrayBuffer()); const dataUrl = `data:${file.type};base64,${bytes.toString('base64')}`

    const firstPass = await callVision(apiKey, dataUrl, basePrompt)
    let finalPass = firstPass
    let disagreement: boolean[] = []
    try {
      finalPass = await callVision(apiKey, dataUrl, verificationPrompt, JSON.stringify(firstPass))
      const firstLines = Array.isArray(firstPass?.lines) ? firstPass.lines : []
      const finalLines = Array.isArray(finalPass?.lines) ? finalPass.lines : []
      const count = Math.max(firstLines.length, finalLines.length)
      disagreement = Array.from({ length: count }, (_, index) => lineSignature(firstLines[index]) !== lineSignature(finalLines[index]))
      for (let i = 0; i < finalLines.length; i++) {
        finalLines[i].needsReview = Boolean(disagreement[i]) || Boolean(firstLines[i]?.needsReview) || Boolean(finalLines[i]?.needsReview)
      }
      finalPass.lines = finalLines
    } catch (error) { console.error('Second-pass handwriting verification failed; using first pass', error) }

    return NextResponse.json({ ...normalizeExtraction(finalPass, disagreement.length ? disagreement : undefined), ocrSource: 'openai-vision-stores-issue-two-pass-agreement' })
  } catch (error) {
    console.error('Handwriting extraction error', error); const message = error instanceof Error ? error.message : ''
    if (message.includes('OpenAI extraction')) return NextResponse.json({ error: 'The handwriting reader could not reliably process this photo. Try a clearer, straight-on photo.' }, { status: 502 })
    return NextResponse.json({ error: 'Unable to extract handwriting from this photo.' }, { status: 500 })
  }
}
