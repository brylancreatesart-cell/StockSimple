'use client'

import { useMemo, useState } from 'react'

type Line = { description: string; itemNumber: string; location: string; quantity: string }

const emptyLine = (): Line => ({ description: '', itemNumber: '', location: '', quantity: '' })

export default function Home() {
  const [file, setFile] = useState<File | null>(null)
  const [preview, setPreview] = useState<string | null>(null)
  const [company, setCompany] = useState('')
  const [project, setProject] = useState('')
  const [takenBy, setTakenBy] = useState('')
  const [notes, setNotes] = useState('')
  const [lines, setLines] = useState<Line[]>([emptyLine()])
  const [stage, setStage] = useState<'capture' | 'review'>('capture')
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState('')
  const [savedId, setSavedId] = useState('')

  const canReview = useMemo(() => Boolean(file && takenBy.trim() && lines.some((line) => line.quantity !== '')), [file, takenBy, lines])

  function chooseFile(next: File | undefined) {
    if (!next) return
    setFile(next)
    setPreview((current) => {
      if (current) URL.revokeObjectURL(current)
      return next.type.startsWith('image/') ? URL.createObjectURL(next) : null
    })
    setSaveError('')
    setSavedId('')
  }

  function updateLine(index: number, key: keyof Line, value: string) {
    setLines((current) => current.map((line, i) => i === index ? { ...line, [key]: value } : line))
  }

  function addLine() { setLines((current) => [...current, emptyLine()]) }
  function removeLine(index: number) { setLines((current) => current.length === 1 ? current : current.filter((_, i) => i !== index)) }

  async function approveAndSave() {
    if (!file) return
    setSaving(true)
    setSaveError('')
    setSavedId('')
    try {
      const formData = new FormData()
      formData.append('file', file)
      formData.append('company', company)
      formData.append('project', project)
      formData.append('takenBy', takenBy)
      formData.append('notes', notes)
      formData.append('lines', JSON.stringify(lines))

      const response = await fetch('/api/stock', { method: 'POST', body: formData })
      const result = await response.json()
      if (!response.ok) throw new Error(result.error || 'Unable to save the stock record.')
      setSavedId(result.id)
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : 'Unable to save the stock record.')
    } finally {
      setSaving(false)
    }
  }

  return (
    <main className="shell">
      <header className="row"><div className="brand">Stock<span>Simple</span></div><div className="status">Draft-first workflow</div></header>
      <section className="hero"><h1>Turn a paper stock sheet into a clean inventory record.</h1><p className="muted">Photo → extraction → review → approval. Nothing becomes final until you approve it.</p></section>
      <nav className="nav" aria-label="Workflow">
        <button className={stage === 'capture' ? 'active' : ''} onClick={() => setStage('capture')}>1. Capture</button>
        <button className={stage === 'review' ? 'active' : ''} onClick={() => canReview && setStage('review')}>2. Review & approve</button>
      </nav>
      {stage === 'capture' ? (
        <section className="card">
          <h2>New stock record</h2>
          <div className="grid grid2">
            <label>Company<input value={company} onChange={(e) => setCompany(e.target.value)} placeholder="Company name" /></label>
            <label>Project<input value={project} onChange={(e) => setProject(e.target.value)} placeholder="Project number or name" /></label>
            <label>Taken by / printed name<input required value={takenBy} onChange={(e) => setTakenBy(e.target.value)} placeholder="Employee name" /></label>
            <label>Notes<textarea value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Anything unusual about this stock sheet" /></label>
          </div>
          <div className="divider" /><h3>1. Add the paper sheet</h3>
          <div className="drop"><input type="file" accept="image/jpeg,image/png,image/webp,application/pdf" capture="environment" onChange={(e) => chooseFile(e.target.files?.[0])} />{preview && <img className="preview" src={preview} alt="Stock sheet preview" />}{file && <p className="muted">{file.name}</p>}</div>
          <div className="divider" /><div className="row"><h3 style={{ margin: 0 }}>2. Stock lines</h3><div className="spacer" /><button className="secondary" type="button" onClick={addLine}>+ Add line</button></div>
          {lines.map((line, index) => <div className="line" key={index}><div className="row"><strong>Line {index + 1}</strong><div className="spacer" /><button className="secondary" type="button" onClick={() => removeLine(index)}>Remove</button></div><div className="grid grid2" style={{ marginTop: 10 }}><label>Item description<input value={line.description} onChange={(e) => updateLine(index, 'description', e.target.value)} /></label><label>Item number<input value={line.itemNumber} onChange={(e) => updateLine(index, 'itemNumber', e.target.value)} /></label><label>Location<input value={line.location} onChange={(e) => updateLine(index, 'location', e.target.value)} /></label><label>Quantity<input type="number" min="0" step="1" inputMode="numeric" value={line.quantity} onChange={(e) => updateLine(index, 'quantity', e.target.value)} /></label></div></div>)}
          <div className="row" style={{ marginTop: 16 }}><div className="muted">The original sheet will be securely stored with the approved record.</div><div className="spacer" /><button className="button" disabled={!canReview} onClick={() => setStage('review')}>Continue to review</button></div>
        </section>
      ) : (
        <section className="card">
          <div className="row"><div><h2 style={{ marginBottom: 4 }}>Review before approval</h2><div className="muted">Check the extracted information against the original sheet.</div></div><div className="spacer" /><span className="status warning">Needs review</span></div>
          <div className="grid grid2" style={{ marginTop: 18 }}><label>Company<input value={company} onChange={(e) => setCompany(e.target.value)} /></label><label>Project<input value={project} onChange={(e) => setProject(e.target.value)} /></label><label>Taken by / printed name<input value={takenBy} onChange={(e) => setTakenBy(e.target.value)} /></label><label>Notes<textarea value={notes} onChange={(e) => setNotes(e.target.value)} /></label></div>
          {preview && <img className="preview" src={preview} alt="Original stock sheet" />}
          {lines.map((line, index) => <div className="line" key={index}><strong>Line {index + 1}</strong><p style={{ marginBottom: 0 }}>{line.itemNumber || 'No item number'} · {line.description || 'No description'} · {line.location || 'No location'} · Qty {line.quantity || '—'}</p></div>)}
          {saveError && <p role="alert" className="status warning">{saveError}</p>}{savedId && <p role="status" className="status">Saved successfully. Record ID: {savedId}</p>}
          <div className="row" style={{ marginTop: 18 }}><button className="secondary" onClick={() => setStage('capture')}>Back & edit</button><div className="spacer" /><button className="button" disabled={saving || Boolean(savedId)} onClick={approveAndSave}>{saving ? 'Saving…' : savedId ? 'Saved' : 'Approve & save'}</button></div>
        </section>
      )}
    </main>
  )
}
