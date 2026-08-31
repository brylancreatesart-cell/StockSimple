'use client'

import { useMemo, useState } from 'react'

type Line = { description: string; itemNumber: string; location: string; quantity: string; confidence?: number; needsReview?: boolean }

const emptyLine = (): Line => ({ description: '', itemNumber: '', location: '', quantity: '' })
const transactionTypes = ['', 'Miscellaneous Issue', 'Issue to Project', 'Inventory Transfer', 'Issue to Conversion']

export default function Home() {
  const [file, setFile] = useState<File | null>(null)
  const [preview, setPreview] = useState<string | null>(null)
  const [company, setCompany] = useState('')
  const [project, setProject] = useState('')
  const [costCenter, setCostCenter] = useState('')
  const [afe, setAfe] = useState('')
  const [transactionType, setTransactionType] = useState('')
  const [takenBy, setTakenBy] = useState('')
  const [preparedBy, setPreparedBy] = useState('')
  const [approvedBy, setApprovedBy] = useState('')
  const [notes, setNotes] = useState('')
  const [lines, setLines] = useState<Line[]>([emptyLine()])
  const [stage, setStage] = useState<'capture' | 'review'>('capture')
  const [reading, setReading] = useState(false)
  const [ocrError, setOcrError] = useState('')
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState('')
  const [savedId, setSavedId] = useState('')

  const canReview = useMemo(() => Boolean(file && takenBy.trim() && lines.some((line) => line.quantity !== '')), [file, takenBy, lines])
  const reviewWarnings = useMemo(() => lines.filter((line) => line.needsReview || (line.confidence !== undefined && line.confidence < 0.85)).length, [lines])

  function chooseFile(next: File | undefined) {
    if (!next) return
    setFile(next)
    setPreview((current) => { if (current) URL.revokeObjectURL(current); return next.type.startsWith('image/') ? URL.createObjectURL(next) : null })
    setOcrError(''); setSaveError(''); setSavedId('')
  }

  function updateLine(index: number, key: keyof Line, value: string) {
    setLines((current) => current.map((line, i) => i === index ? { ...line, [key]: value, needsReview: key === 'description' || key === 'itemNumber' || key === 'location' || key === 'quantity' ? false : line.needsReview } : line))
  }

  function addLine() { setLines((current) => [...current, emptyLine()]) }
  function removeLine(index: number) { setLines((current) => current.length === 1 ? current : current.filter((_, i) => i !== index)) }

  async function readPaperSheet() {
    if (!file) return
    if (file.type === 'application/pdf') {
      setOcrError('For handwriting extraction, please use a photo (JPG, PNG, or WEBP) of the sheet.')
      return
    }
    setReading(true); setOcrError(''); setSaveError(''); setSavedId('')
    try {
      const formData = new FormData()
      formData.append('file', file)
      const response = await fetch('/api/stock/extract', { method: 'POST', body: formData })
      const result = await response.json()
      if (!response.ok) throw new Error(result.error || 'Unable to read the stock sheet.')
      setCostCenter(result.costCenter || '')
      setAfe(result.afe || '')
      setTransactionType(transactionTypes.includes(result.transactionType) ? result.transactionType : '')
      setNotes(result.remarks || '')
      setTakenBy(result.receivedReturnedBy || '')
      setPreparedBy(result.preparedBy || '')
      setApprovedBy(result.approvedBy || '')
      const extractedLines: Line[] = Array.isArray(result.lines) && result.lines.length
        ? result.lines.map((line: { description?: string; itemNumber?: string; location?: string; quantity?: string; ocrConfidence?: number; needsReview?: boolean }) => ({
            description: line.description || '',
            itemNumber: line.itemNumber || '',
            location: line.location || '',
            quantity: line.quantity || '',
            confidence: typeof line.ocrConfidence === 'number' ? line.ocrConfidence : undefined,
            needsReview: Boolean(line.needsReview),
          }))
        : [emptyLine()]
      setLines(extractedLines)
      setStage('review')
    } catch (error) { setOcrError(error instanceof Error ? error.message : 'Unable to read the stock sheet.') }
    finally { setReading(false) }
  }

  async function approveAndSave() {
    if (!file) return
    setSaving(true); setSaveError(''); setSavedId('')
    try {
      const formData = new FormData(); formData.append('file', file); formData.append('company', company); formData.append('project', project); formData.append('takenBy', takenBy); formData.append('notes', notes); formData.append('lines', JSON.stringify(lines))
      const response = await fetch('/api/stock', { method: 'POST', body: formData }); const result = await response.json()
      if (!response.ok) throw new Error(result.error || 'Unable to save the stock record.')
      setSavedId(result.id)
    } catch (error) { setSaveError(error instanceof Error ? error.message : 'Unable to save the stock record.') }
    finally { setSaving(false) }
  }

  return (
    <main className="shell">
      <header className="row"><div className="brand">Stock<span>Simple</span></div><div className="status">Stores issue document</div></header>
      <section className="hero"><h1>Turn a paper stock sheet into a clean inventory record.</h1><p className="muted">Photo → handwriting extraction → review → approval. Nothing becomes final until you approve it.</p></section>
      <nav className="nav" aria-label="Workflow"><button className={stage === 'capture' ? 'active' : ''} onClick={() => setStage('capture')}>1. Capture</button><button className={stage === 'review' ? 'active' : ''} onClick={() => canReview && setStage('review')}>2. Review & approve</button></nav>
      {stage === 'capture' ? (
        <section className="card">
          <h2>New stock record</h2>
          <div className="grid grid2">
            <label>Company<input value={company} onChange={(e) => setCompany(e.target.value)} placeholder="Company name" /></label>
            <label>Project<input value={project} onChange={(e) => setProject(e.target.value)} placeholder="Project number or name" /></label>
            <label>Cost center<input value={costCenter} onChange={(e) => setCostCenter(e.target.value)} /></label>
            <label>AFE<input value={afe} onChange={(e) => setAfe(e.target.value)} /></label>
            <label>Transaction type<select value={transactionType} onChange={(e) => setTransactionType(e.target.value)}>{transactionTypes.map((type) => <option key={type} value={type}>{type || 'Select transaction type'}</option>)}</select></label>
            <label>Taken by / received-returned by<input required value={takenBy} onChange={(e) => setTakenBy(e.target.value)} placeholder="Employee name" /></label>
            <label>Prepared by<input value={preparedBy} onChange={(e) => setPreparedBy(e.target.value)} /></label>
            <label>Approved by<input value={approvedBy} onChange={(e) => setApprovedBy(e.target.value)} /></label>
            <label>Remarks / notes<textarea value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Anything unusual about this stock sheet" /></label>
          </div>
          <div className="divider" /><h3>1. Add the paper sheet</h3>
          <div className="drop"><input type="file" accept="image/jpeg,image/png,image/webp,application/pdf" capture="environment" onChange={(e) => chooseFile(e.target.files?.[0])} />{preview && <img className="preview" src={preview} alt="Stock sheet preview" />}{file && <p className="muted">{file.name}</p>}</div>
          {file && <div className="row" style={{ marginTop: 12 }}><div className="muted">The reader uses the Stores Issue Document layout to map handwriting into the correct fields.</div><div className="spacer" /><button className="button" type="button" onClick={readPaperSheet} disabled={reading}>{reading ? 'Reading handwriting…' : 'Read handwriting & auto-fill'}</button></div>}
          {ocrError && <p role="alert" className="status warning" style={{ marginTop: 12 }}>{ocrError}</p>}
          <div className="divider" /><div className="row"><h3 style={{ margin: 0 }}>2. Stock lines</h3><div className="spacer" /><button className="secondary" type="button" onClick={addLine}>+ Add line</button></div>
          {lines.map((line, index) => <div className="line" key={index}><div className="row"><strong>Line {index + 1}</strong>{line.needsReview && <span className="status warning">Needs review</span>}<div className="spacer" /><button className="secondary" type="button" onClick={() => removeLine(index)}>Remove</button></div><div className="grid grid2" style={{ marginTop: 10 }}><label>Item description<input value={line.description} onChange={(e) => updateLine(index, 'description', e.target.value)} /></label><label>Item number<input value={line.itemNumber} onChange={(e) => updateLine(index, 'itemNumber', e.target.value)} /></label><label>Locator<input value={line.location} onChange={(e) => updateLine(index, 'location', e.target.value)} /></label><label>Quantity<input type="number" min="0" step="1" inputMode="numeric" value={line.quantity} onChange={(e) => updateLine(index, 'quantity', e.target.value)} /></label></div></div>)}
          <div className="row" style={{ marginTop: 16 }}><div className="muted">The original sheet will be stored with the approved record.</div><div className="spacer" /><button className="button" disabled={!canReview} onClick={() => setStage('review')}>Continue to review</button></div>
        </section>
      ) : (
        <section className="card">
          <div className="row"><div><h2 style={{ marginBottom: 4 }}>Review before approval</h2><div className="muted">Compare every field with the original sheet before saving.</div></div><div className="spacer" /><span className="status warning">{reviewWarnings ? `${reviewWarnings} line${reviewWarnings === 1 ? '' : 's'} need review` : 'Ready for review'}</span></div>
          {preview && <img className="preview" src={preview} alt="Original stock sheet" />}
          <div className="grid grid2" style={{ marginTop: 18 }}>
            <label>Company<input value={company} onChange={(e) => setCompany(e.target.value)} /></label><label>Project<input value={project} onChange={(e) => setProject(e.target.value)} /></label>
            <label>Cost center<input value={costCenter} onChange={(e) => setCostCenter(e.target.value)} /></label><label>AFE<input value={afe} onChange={(e) => setAfe(e.target.value)} /></label>
            <label>Transaction type<select value={transactionType} onChange={(e) => setTransactionType(e.target.value)}>{transactionTypes.map((type) => <option key={type} value={type}>{type || 'Select transaction type'}</option>)}</select></label>
            <label>Taken by / received-returned by<input value={takenBy} onChange={(e) => setTakenBy(e.target.value)} /></label><label>Prepared by<input value={preparedBy} onChange={(e) => setPreparedBy(e.target.value)} /></label><label>Approved by<input value={approvedBy} onChange={(e) => setApprovedBy(e.target.value)} /></label>
            <label>Remarks / notes<textarea value={notes} onChange={(e) => setNotes(e.target.value)} /></label>
          </div>
          {lines.map((line, index) => <div className="line" key={index}><div className="row"><strong>Line {index + 1}</strong><div className="spacer" />{line.confidence !== undefined && <span className="status">OCR confidence {Math.round(line.confidence * 100)}%</span>}{line.needsReview && <span className="status warning">Check this line</span>}</div><div className="grid grid2" style={{ marginTop: 10 }}><label>Item description<input value={line.description} onChange={(e) => updateLine(index, 'description', e.target.value)} /></label><label>Item number<input value={line.itemNumber} onChange={(e) => updateLine(index, 'itemNumber', e.target.value)} /></label><label>Locator<input value={line.location} onChange={(e) => updateLine(index, 'location', e.target.value)} /></label><label>Quantity<input type="number" min="0" step="1" inputMode="numeric" value={line.quantity} onChange={(e) => updateLine(index, 'quantity', e.target.value)} /></label></div></div>)}
          {saveError && <p role="alert" className="status warning">{saveError}</p>}{savedId && <p role="status" className="status">Saved successfully. Record ID: {savedId}</p>}
          <div className="row" style={{ marginTop: 18 }}><button className="secondary" onClick={() => setStage('capture')}>Back & edit</button><div className="spacer" /><button className="button" disabled={saving || Boolean(savedId) || reviewWarnings > 0} onClick={approveAndSave}>{saving ? 'Saving…' : savedId ? 'Saved' : reviewWarnings ? 'Resolve review items first' : 'Approve & save'}</button></div>
        </section>
      )}
    </main>
  )
}
