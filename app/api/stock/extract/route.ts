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
  type: 'object',
  additionalProperties: false,
  properties: {
    costCenter: { type: 'string' },
    afe: { type: 'string' },
    transactionType: {
      type: 'string',
      enum: ['Miscellaneous Issue', 'Issue to Project', 'Inventory Transfer', 'Issue to Conversion', '']
    },
    remarks: { type: 'string' },
    receivedReturnedBy: { type: 'string' },
    preparedBy: { type: 'string' },
    approvedBy: { type: 'string' },
    lines: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          description: { type: 'string' },
          itemNumber: { type: 'string' },
          location: { type: 'string' },
          quantity: { type: 'string' },
          ocrConfidence: { type: 'number', minimum: 0, maximum: 1 },
          needsReview: { type: 'boolean' }
        },
        required: ['description', 'itemNumber', 'location', 'quantity', 'ocrConfidence', 'needsReview']
      }
    }
  },
  required: ['costCenter', 'afe', 'transactionType', 'remarks', 'receivedReturnedBy', 'preparedBy', 'approvedBy', 'lines']
}

const basePrompt = `You are a high-accuracy document vision system extracting a handwritten Stores Issue Document. Accuracy of field value and physical row/column placement is more important than guessing.

FIRST, understand the physical form before transcribing it. Locate the printed field boundaries, table grid, handwritten marks, and checkbox area. Then perform a separate visual pass to transcribe the handwriting.

FIXED FORM REGIONS:
- COST CENTER
- AFE
- TRANSACTION TYPE with four checkbox choices: Miscellaneous Issue, Issue to Project, Inventory Transfer, Issue to Conversion
- INVENTORY TABLE with columns, left-to-right: DESCRIPTION, ITEM NO., LOCATOR, QUANTITY
- REMARKS/NOTES
- RECEIVED/RETURNED BY
- PREPARED BY
- APPROVED

FIELD ACCURACY RULES:
- Read handwriting and user-entered marks only. Never copy printed labels into values.
- Do not guess missing handwriting. If genuinely unreadable, use an empty string.
- Do not silently correct spelling, identifiers, or names.
- Preserve capitalization, punctuation, spacing when meaningful, and leading zeros exactly when legible.
- For identifiers, distinguish digits from letters using the field context but only return what is visually supported.
- For QUANTITY, return only the visible number as a string. Do not add units, arithmetic, or inferred quantities.
- For checkboxes, identify the actual visible check, X, mark, or selection. If none is clearly selected, return an empty transactionType.
- Pay special attention to 0/O, 1/I/l, 2/Z, 5/S, 6/G, 8/B, and 9/g. Do not resolve ambiguity by guessing.

TABLE ACCURACY RULES:
- Treat every horizontal table row as an independent record.
- Treat DESCRIPTION, ITEM NO., LOCATOR, and QUANTITY as strict vertical regions.
- A handwritten value belongs to the physical cell containing it, not the nearest readable text.
- Never move a value into a neighboring column because another interpretation looks more plausible.
- Keep values on the same physical row together. Never combine handwriting from different rows.
- Ignore completely blank rows.
- If handwriting crosses a grid line, use the intended cell only when visually clear; otherwise leave the affected value empty and set needsReview true.

CONFIDENCE:
- ocrConfidence is confidence that the entire extracted line is correct, including value recognition AND row/column placement.
- Lower confidence for blurry, faint, crossed-out, cramped, partially obscured, or ambiguous handwriting.
- Set needsReview true whenever any value is ambiguous, any row/column placement is uncertain, or confidence is below 0.85.
- Never inflate confidence simply because a value is plausible.

Return only the requested structured data.`

const verificationPrompt = `You are the FINAL QUALITY-CONTROL reviewer for a handwritten Stores Issue Document.

The image is the authoritative source. A first extraction is supplied below as a draft. Carefully inspect the ORIGINAL IMAGE again and independently verify every field and every table row against the physical handwriting and grid.

Do not assume the draft is correct. Correct it whenever the image supports a different value, row, column, checkbox, or blank value.

QUALITY-CONTROL CHECKLIST:
1. Verify COST CENTER character-by-character against the handwriting.
2. Verify AFE character-by-character against the handwriting.
3. Verify the transaction checkbox from the visible mark; never infer it.
4. Verify REMARKS/NOTES against the handwriting without inventing missing text.
5. Verify RECEIVED/RETURNED BY, PREPARED BY, and APPROVED against the visible handwriting.
6. Count only physically nonblank inventory rows.
7. For each row, independently verify DESCRIPTION, ITEM NO., LOCATOR, and QUANTITY.
8. Confirm every value remains in its physical column and row.
9. Pay special attention to handwritten digit/letter confusions: 0/O, 1/I/l, 2/Z, 5/S, 6/G, 8/B, 9/g.
10. Preserve leading zeros and exact visible identifiers.
11. For quantity, return only the visible number as a string.
12. Never guess. If the image does not support a character or value, leave it empty and flag the line for review.
13. Recalculate each line's confidence based on the final image comparison. Set needsReview true for any ambiguity or confidence below 0.85.

The final response must contain only the corrected structured data matching the supplied schema.`

function extractOutputText(result: any): string {
  if (typeof result?.output_text === 'string' && result.output_text.trim()) return result.output_text.trim()
  const parts: string[] = []
  for (const outputItem of Array.isArray(result?.output) ? result.output : []) {
    if (outputItem?.type !== 'message') continue
    for (const content of Array.isArray(outputItem.content) ? outputItem.content : []) {
      if ((content?.type === 'output_text' || content?.type === 'text') && typeof content.text === 'string') parts.push(content.text)
    }
  }
  return parts.join('').trim()
}

async function callVision(apiKey: string, dataUrl: string, prompt: string, draft?: string) {
  const inputText = draft ? `${prompt}\n\nFIRST-PASS DRAFT TO AUDIT:\n${draft}` : prompt
  const response = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model: 'gpt-5.6-luna',
      input: [{
        role: 'user',
        content: [
          { type: 'input_text', text: inputText },
          { type: 'input_image', image_url: dataUrl, detail: 'high' },
        ],
      }],
      text: { format: { type: 'json_schema', name: 'stores_issue_document', strict: true, schema } },
    }),
  })

  if (!response.ok) {
    const errorBody = await response.text()
    console.error('OpenAI extraction call failed', response.status, errorBody)
    throw new Error('OpenAI extraction request failed')
  }

  const result = await response.json()
  const outputText = extractOutputText(result)
  if (!outputText) {
    console.error('OpenAI extraction returned no text output', { responseId: result?.id, status: result?.status })
    throw new Error('OpenAI extraction returned no text')
  }

  try {
    return JSON.parse(outputText)
  } catch (error) {
    console.error('OpenAI extraction returned invalid JSON', { outputText, error })
    throw new Error('OpenAI extraction returned invalid JSON')
  }
}

function normalizeExtraction(extracted: any) {
  const lines: ExtractedLine[] = Array.isArray(extracted?.lines) ? extracted.lines.map((line: ExtractedLine) => ({
    description: String(line?.description || ''),
    itemNumber: String(line?.itemNumber || ''),
    location: String(line?.location || ''),
    quantity: String(line?.quantity || ''),
    ocrConfidence: Math.max(0, Math.min(1, Number(line?.ocrConfidence) || 0)),
    needsReview: Boolean(line?.needsReview),
  })) : []

  return {
    costCenter: String(extracted?.costCenter || ''),
    afe: String(extracted?.afe || ''),
    transactionType: ['Miscellaneous Issue', 'Issue to Project', 'Inventory Transfer', 'Issue to Conversion'].includes(extracted?.transactionType) ? extracted.transactionType : '',
    remarks: String(extracted?.remarks || ''),
    receivedReturnedBy: String(extracted?.receivedReturnedBy || ''),
    preparedBy: String(extracted?.preparedBy || ''),
    approvedBy: String(extracted?.approvedBy || ''),
    lines,
  }
}

export async function POST(request: Request) {
  try {
    const apiKey = process.env.OPENAI_API_KEY
    if (!apiKey) return NextResponse.json({ error: 'Handwriting extraction is not configured yet. Add OPENAI_API_KEY to Vercel Production environment variables.' }, { status: 500 })

    const formData = await request.formData()
    const file = formData.get('file')
    if (!(file instanceof File)) return NextResponse.json({ error: 'A photo of the stock sheet is required.' }, { status: 400 })
    if (!ALLOWED_TYPES.has(file.type)) return NextResponse.json({ error: 'For handwriting extraction, upload a JPG, PNG, or WEBP photo.' }, { status: 400 })
    if (file.size === 0 || file.size > MAX_FILE_SIZE) return NextResponse.json({ error: 'The stock sheet photo must be between 1 byte and 10 MB.' }, { status: 400 })

    const bytes = Buffer.from(await file.arrayBuffer())
    const dataUrl = `data:${file.type};base64,${bytes.toString('base64')}`

    // Pass 1: extract the form from scratch.
    const firstPass = await callVision(apiKey, dataUrl, basePrompt)

    // Pass 2: independently re-inspect the same image while auditing the draft.
    // This is intentionally a second vision pass because row/column alignment and
    // ambiguous handwritten characters are the highest-risk failure modes.
    let finalPass = firstPass
    try {
      finalPass = await callVision(apiKey, dataUrl, verificationPrompt, JSON.stringify(firstPass))
    } catch (verificationError) {
      // A failed QC pass should not discard a successful first extraction.
      console.error('Second-pass handwriting verification failed; using first pass', verificationError)
    }

    const extracted = normalizeExtraction(finalPass)
    return NextResponse.json({ ...extracted, ocrSource: 'openai-vision-stores-issue-two-pass' })
  } catch (error) {
    console.error('Handwriting extraction error', error)
    const message = error instanceof Error ? error.message : ''
    if (message.includes('OpenAI extraction')) return NextResponse.json({ error: 'The handwriting reader could not reliably process this photo. Try a clearer, straight-on photo.' }, { status: 502 })
    return NextResponse.json({ error: 'Unable to extract handwriting from this photo.' }, { status: 500 })
  }
}
