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

const extractionPrompt = `You are a high-accuracy document vision system extracting a handwritten Stores Issue Document. Accuracy of row/column placement is more important than guessing a value.

FIRST, understand the physical form before transcribing it. Locate the printed field boundaries, table grid, handwritten marks, and checkbox area. Then perform a second visual pass to transcribe the handwriting. Mentally cross-check every extracted table row against the original image before returning the result.

FIXED FORM REGIONS:
- COST CENTER
- AFE
- TRANSACTION TYPE with four checkbox choices: Miscellaneous Issue, Issue to Project, Inventory Transfer, Issue to Conversion
- INVENTORY TABLE with columns, left-to-right: DESCRIPTION, ITEM NO., LOCATOR, QUANTITY
- REMARKS/NOTES
- RECEIVED/RETURNED BY
- PREPARED BY
- APPROVED

CRITICAL TABLE RULES:
- Treat every horizontal table row as an independent record.
- Treat the four table columns as strict vertical regions. A mark belongs to the column whose cell contains it, not the nearest readable text elsewhere.
- Never shift a value into a neighboring column just because the handwriting is easier to read there.
- Keep values on the same physical row together. Never combine handwriting from different rows.
- Ignore completely blank rows.
- If handwriting crosses a grid line, use the writer's apparent intended cell only when that is visually clear; otherwise leave the affected value empty and set needsReview true.
- Preserve item numbers, locators, punctuation, capitalization, and leading zeros exactly when legible.
- For QUANTITY, transcribe only the visible number as a string. Do not add units, arithmetic, or inferred quantities.

HANDWRITING RULES:
- Read handwriting and user-entered marks only. Never copy printed labels into extracted values.
- Do not guess. If a character or word is genuinely unreadable, return the portion you can confidently read only if it remains unambiguous; otherwise return an empty string.
- Do not silently correct spelling or normalize identifiers.
- Distinguish digits from letters using the surrounding field and writing context, but never invent a character.
- For checkboxes, identify the actual visible check, X, mark, or selection. Do not infer a transaction type from other fields.
- If no transaction option is clearly selected, return an empty string.
- Pay special attention to visually similar characters such as 0/O, 1/I, 2/Z, 5/S, 6/G, 8/B, and 9/g. Preserve what is actually visible rather than choosing a prettier value.

CONFIDENCE:
- ocrConfidence is the confidence that the entire extracted line is correct, including row and column placement.
- Lower confidence for blurry, faint, crossed-out, cramped, partially obscured, ambiguous, or unusually shaped handwriting.
- Set needsReview true whenever any value on the line is ambiguous, any column/row placement is uncertain, or confidence is below 0.85.
- Do not use high confidence merely because a plausible value can be guessed from context.

FINAL CHECK BEFORE RETURNING:
1. Count the nonblank handwritten table rows.
2. Verify each extracted line corresponds to exactly one physical table row.
3. Verify each value stayed in its original column.
4. Verify quantities are not accidentally copied from item numbers or locators.
5. Verify leading zeros and identifiers were preserved.
6. Verify checkbox selection from the visible mark.
7. Verify every uncertain line is flagged for review.

Return only the requested structured data.`

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
