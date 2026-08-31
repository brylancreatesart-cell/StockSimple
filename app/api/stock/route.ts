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

const MAX_FILE_SIZE = 10 * 1024 * 1024
const ALLOWED_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'application/pdf'])

function safeFileName(name: string) {
  const cleaned = name.trim().replace(/[^a-zA-Z0-9._-]+/g, '_')
  return cleaned || 'stock-sheet'
}

export async function POST(request: Request) {
  let documentId: string | null = null
  let storagePath: string | null = null

  try {
    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
    const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY

    if (!supabaseUrl || !serviceRoleKey) {
      return NextResponse.json({ error: 'Supabase server configuration is missing.' }, { status: 500 })
    }

    const formData = await request.formData()
    const file = formData.get('file')
    const takenBy = String(formData.get('takenBy') || '').trim()
    const company = String(formData.get('company') || '').trim()
    const project = String(formData.get('project') || '').trim()
    const notes = String(formData.get('notes') || '').trim()
    const linesRaw = String(formData.get('lines') || '[]')

    if (!(file instanceof File)) {
      return NextResponse.json({ error: 'A stock sheet file is required.' }, { status: 400 })
    }
    if (!ALLOWED_TYPES.has(file.type)) {
      return NextResponse.json({ error: 'Unsupported stock sheet file type.' }, { status: 400 })
    }
    if (file.size === 0 || file.size > MAX_FILE_SIZE) {
      return NextResponse.json({ error: 'Stock sheet must be between 1 byte and 10 MB.' }, { status: 400 })
    }
    if (!takenBy) {
      return NextResponse.json({ error: 'Taken by is required.' }, { status: 400 })
    }

    let lines: Line[]
    try {
      const parsed = JSON.parse(linesRaw)
      if (!Array.isArray(parsed) || parsed.length === 0) throw new Error('invalid lines')
      lines = parsed
    } catch {
      return NextResponse.json({ error: 'Stock lines are invalid.' }, { status: 400 })
    }

    const supabase = createClient(supabaseUrl, serviceRoleKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    })

    const { data: document, error: documentError } = await supabase
      .from('stock_documents')
      .insert({
        company: company || null,
        project: project || null,
        taken_by: takenBy,
        notes: notes || null,
        source_file_name: file.name,
        status: 'approved',
        approved_at: new Date().toISOString(),
      })
      .select('id')
      .single()

    if (documentError) throw documentError
    documentId = document.id

    storagePath = `${document.id}/${safeFileName(file.name)}`
    const fileBytes = Buffer.from(await file.arrayBuffer())
    const { error: uploadError } = await supabase.storage
      .from('stock-sheets')
      .upload(storagePath, fileBytes, {
        contentType: file.type,
        upsert: false,
      })

    if (uploadError) throw uploadError

    const { error: sourceUpdateError } = await supabase
      .from('stock_documents')
      .update({ source_file_url: storagePath })
      .eq('id', document.id)

    if (sourceUpdateError) throw sourceUpdateError

    const items = lines.map((line, index) => ({
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
    if (itemsError) throw itemsError

    return NextResponse.json({ id: document.id, status: 'approved', sourceFilePath: storagePath })
  } catch (error) {
    console.error('Stock save failed', error)

    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
    const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY
    if (supabaseUrl && serviceRoleKey) {
      const supabase = createClient(supabaseUrl, serviceRoleKey, {
        auth: { autoRefreshToken: false, persistSession: false },
      })
      if (storagePath) await supabase.storage.from('stock-sheets').remove([storagePath]).catch(() => undefined)
      if (documentId) await supabase.from('stock_documents').delete().eq('id', documentId).catch(() => undefined)
    }

    return NextResponse.json({ error: 'Unable to save the stock record.' }, { status: 500 })
  }
}
