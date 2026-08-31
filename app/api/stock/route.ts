import { NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'

type Line = {
  description: string
  itemNumber: string
  location: string
  quantity: string
  ocrConfidence?: number | null
  ocrSource?: string | null
  needsReview?: boolean
}

type StockPayload = {
  company?: string
  project?: string
  takenBy: string
  notes?: string
  sourceFileName?: string
  lines: Line[]
}

export async function POST(request: Request) {
  try {
    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
    const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY

    if (!supabaseUrl || !serviceRoleKey) {
      return NextResponse.json({ error: 'Supabase server configuration is missing.' }, { status: 500 })
    }

    const body = (await request.json()) as StockPayload
    if (!body.takenBy?.trim() || !Array.isArray(body.lines) || body.lines.length === 0) {
      return NextResponse.json({ error: 'Taken by and at least one stock line are required.' }, { status: 400 })
    }

    const supabase = createClient(supabaseUrl, serviceRoleKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    })

    const { data: document, error: documentError } = await supabase
      .from('stock_documents')
      .insert({
        company: body.company?.trim() || null,
        project: body.project?.trim() || null,
        taken_by: body.takenBy.trim(),
        notes: body.notes?.trim() || null,
        source_file_name: body.sourceFileName || null,
        status: 'approved',
        approved_at: new Date().toISOString(),
      })
      .select('id')
      .single()

    if (documentError) throw documentError

    const items = body.lines.map((line, index) => ({
      document_id: document.id,
      line_number: index + 1,
      item_number: line.itemNumber?.trim() || null,
      description: line.description?.trim() || null,
      location: line.location?.trim() || null,
      quantity: line.quantity === '' ? null : Number(line.quantity),
      ocr_confidence: line.ocrConfidence ?? null,
      ocr_source: line.ocrSource ?? null,
      needs_review: line.needsReview ?? false,
    }))

    const { error: itemsError } = await supabase.from('stock_items').insert(items)
    if (itemsError) {
      await supabase.from('stock_documents').delete().eq('id', document.id)
      throw itemsError
    }

    return NextResponse.json({ id: document.id, status: 'approved' })
  } catch (error) {
    console.error('Stock save failed', error)
    return NextResponse.json({ error: 'Unable to save the stock record.' }, { status: 500 })
  }
}
