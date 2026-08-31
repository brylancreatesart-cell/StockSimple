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

const extractionPrompt = `You are extracting handwriting from a Stores Issue Document.

The printed form has these fixed regions:
- COST CENTER
- AFE
- TRANSACTION TYPE with four checkbox choices: Miscellaneous Issue, Issue to Project, Inventory Transfer, Issue to Conversion
- A large inventory table with columns exactly: DESCRIPTION, ITEM NO., LOCATOR, QUANTITY
- REMARKS/NOTES
- RECEIVED/RETURNED BY
- PREPARED BY
- APPROVED

Read only handwriting or other user-entered marks. Do not copy the printed labels into values.
Use the table grid to keep each handwritten value in its own column and row. Never move a value from one column into another.
Ignore blank table rows. Preserve item numbers, locators, punctuation, and leading zeros exactly when legible.
For quantity, return the visible number as a string; do not invent units or quantities.
For the transaction type, select the option that is actually checked. If no option is clearly checked, return an empty string.
Do not guess missing handwriting. Empty or unreadable fields should be empty strings.

Confidence is your confidence that the extracted value is correct. Use a lower confidence when handwriting is ambiguous, blurry, crossed out, partially outside a cell, or otherwise uncertain. Set needsReview true whenever confidence is below 0.85 or the value is ambiguous.`

function extractOutputText(result: any): string {
  if (typeof result?.output_text === 'string' && result.output_text.trim()) {
    return result.output_text.trim()
  }

  const parts: string[] = []
  for (const outputItem of Array.isArray(result?.output) ? result.output : []) {
    if (outputItem?.type !== 'message') continue
    for (const content of Array.isArray(outputItem.content) ? outputItem.content : []) {
      if ((content?.type === 'output_text' || content?.type === 'text') && typeof content.text === 'string') {
        parts.push(content.text)
      }
    }
  }

  return parts.join('').trim()
}

export async function POST(request: Request) {
  try {
    const apiKey = process.env.OPENAI_API_KEY
    if (!apiKey) {
      return NextResponse.json({ error: 'Handwriting extraction is not configured yet. Add OPENAI_API_KEY to Vercel Production environment variables.' }, { status: 500 })
    }

    const formData = await request.formData()
    const file = formData.get('file')

    if (!(file instanceof File)) {
      return NextResponse.json({ error: 'A photo of the stock sheet is required.' }, { status: 400 })
    }
    if (!ALLOWED_TYPES.has(file.type)) {
      return NextResponse.json({ error: 'For handwriting extraction, upload a JPG, PNG, or WEBP photo.' }, { status: 400 })
    }
    if (file.size === 0 || file.size > MAX_FILE_SIZE) {
      return NextResponse.json({ error: 'The stock sheet photo must be between 1 byte and 10 MB.' }, { status: 400 })
    }

    const bytes = Buffer.from(await file.arrayBuffer())
    const dataUrl = `data:${file.type};base64,${bytes.toString('base64')}`

    const response = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: 'gpt-5.6-luna',
        input: [{
          role: 'user',
          content: [
            { type: 'input_text', text: extractionPrompt },
            { type: 'input_image', image_url: dataUrl, detail: 'high' },
          ],
        }],
        text: {
          format: {
            type: 'json_schema',
            name: 'stores_issue_document',
            strict: true,
            schema,
          },
        },
      }),
    })

    if (!response.ok) {
      const errorBody = await response.text()
      console.error('OpenAI extraction failed', response.status, errorBody)
      return NextResponse.json({ error: 'The handwriting reader could not process this photo. Try a clearer, straight-on photo.' }, { status: 502 })
    }

    const result = await response.json()
    const outputText = extractOutputText(result)

    if (!outputText) {
      console.error('OpenAI extraction returned no text output', {
        responseId: result?.id,
        status: result?.status,
        outputTypes: Array.isArray(result?.output) ? result.output.map((item: any) => item?.type) : [],
      })
      return NextResponse.json({ error: 'The handwriting reader returned no extracted information. Please try the photo again.' }, { status: 502 })
    }

    let extracted: any
    try {
      extracted = JSON.parse(outputText)
    } catch (parseError) {
      console.error('OpenAI extraction returned invalid JSON', { outputText, parseError })
      return NextResponse.json({ error: 'The handwriting reader returned an unreadable result. Please try the photo again.' }, { status: 502 })
    }

    const lines: ExtractedLine[] = Array.isArray(extracted.lines) ? extracted.lines.map((line: ExtractedLine) => ({
      description: String(line.description || ''),
      itemNumber: String(line.itemNumber || ''),
      location: String(line.location || ''),
      quantity: String(line.quantity || ''),
      ocrConfidence: Math.max(0, Math.min(1, Number(line.ocrConfidence) || 0)),
      needsReview: Boolean(line.needsReview),
    })) : []

    return NextResponse.json({
      ...extracted,
      lines,
      ocrSource: 'openai-vision-stores-issue',
    })
  } catch (error) {
    console.error('Handwriting extraction error', error)
    return NextResponse.json({ error: 'Unable to extract handwriting from this photo.' }, { status: 500 })
  }
}
