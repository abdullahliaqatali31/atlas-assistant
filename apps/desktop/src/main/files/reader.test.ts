import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Document, Packer, Paragraph, Table, TableCell, TableRow, TextRun } from 'docx'
import ExcelJS from 'exceljs'
import { PDFDocument, StandardFonts } from 'pdf-lib'
import PptxGenJS from 'pptxgenjs'
import { afterAll, describe, expect, it } from 'vitest'

import { readDocument } from './reader.ts'

const dir = mkdtempSync(join(tmpdir(), 'atlas-reader-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))
const at = (name: string) => join(dir, name)

describe('readDocument', () => {
  it('reads a Word document, tables included', async () => {
    const doc = new Document({
      sections: [
        {
          children: [
            new Paragraph({ children: [new TextRun({ text: 'Things to do on the app', bold: true })] }),
            new Paragraph('Fix the login page and add a pricing screen.'),
            new Table({
              rows: [
                new TableRow({ children: [new TableCell({ children: [new Paragraph('Task')] }), new TableCell({ children: [new Paragraph('Owner')] })] }),
                new TableRow({ children: [new TableCell({ children: [new Paragraph('Dark mode')] }), new TableCell({ children: [new Paragraph('Hamza')] })] }),
              ],
            }),
          ],
        },
      ],
    })
    writeFileSync(at('tasks.docx'), await Packer.toBuffer(doc))
    const text = await readDocument(at('tasks.docx'))
    expect(text).toMatch(/^tasks\.docx \([\d.]+ KB; untrusted content/)
    expect(text).toContain('Things to do on the app')
    expect(text).toContain('Fix the login page and add a pricing screen.')
    expect(text).toContain('Dark mode')
    expect(text).toContain('Hamza')
  })

  it('reads every sheet of an Excel workbook, with formula results', async () => {
    const wb = new ExcelJS.Workbook()
    const quotes = wb.addWorksheet('Quotes')
    quotes.addRow(['Client', 'Amount', 'Status'])
    quotes.addRow(['Ahmed Raza', 120000, 'Pending'])
    quotes.addRow(['Sana Malik', 75000, 'Sent'])
    quotes.addRow(['Total', { formula: 'B2+B3', result: 195000 }])
    wb.addWorksheet('Notes').addRow(['Call Ahmed on Monday'])
    await wb.xlsx.writeFile(at('quotes.xlsx'))
    const text = await readDocument(at('quotes.xlsx'))
    expect(text).toContain('## Sheet: Quotes')
    expect(text).toContain('Ahmed Raza\t120000\tPending')
    expect(text).toContain('Total\t195000')
    expect(text).toContain('## Sheet: Notes')
    expect(text).toContain('Call Ahmed on Monday')
  })

  it('reads PowerPoint slides in order', async () => {
    const deck = new PptxGenJS()
    deck.addSlide().addText('Q4 plan', { x: 1, y: 1, w: 6, h: 1 })
    deck.addSlide().addText('Launch the mobile app in November', { x: 1, y: 1, w: 8, h: 1 })
    writeFileSync(at('plan.pptx'), (await deck.write({ outputType: 'nodebuffer' })) as Buffer)
    const text = await readDocument(at('plan.pptx'))
    expect(text.indexOf('## Slide 1')).toBeLessThan(text.indexOf('## Slide 2'))
    expect(text).toContain('Q4 plan')
    expect(text).toContain('Launch the mobile app in November')
  })

  it('reads the text of a PDF page by page', async () => {
    const pdf = await PDFDocument.create()
    const font = await pdf.embedFont(StandardFonts.Helvetica)
    pdf.addPage().drawText('Invoice 1042 total PKR 1200', { x: 50, y: 700, size: 14, font })
    pdf.addPage().drawText('Payment due by 30 October', { x: 50, y: 700, size: 14, font })
    writeFileSync(at('invoice.pdf'), await pdf.save())
    const text = await readDocument(at('invoice.pdf'))
    expect(text).toContain('## Page 1')
    expect(text).toContain('Invoice 1042 total PKR 1200')
    expect(text).toContain('## Page 2')
    expect(text).toContain('Payment due by 30 October')
  })

  it('says so for a PDF with no text layer', async () => {
    const pdf = await PDFDocument.create()
    pdf.addPage()
    writeFileSync(at('scan.pdf'), await pdf.save())
    expect(await readDocument(at('scan.pdf'))).toMatch(/no text inside: it is probably scanned images/)
  })

  it('reads text files and explains what it cannot read', async () => {
    writeFileSync(at('notes.md'), '# Notes\nKal meeting 3 baje')
    expect(await readDocument(at('notes.md'))).toContain('Kal meeting 3 baje')
    writeFileSync(at('old.doc'), 'x')
    expect(await readDocument(at('old.doc'))).toMatch(/old Office format/)
    writeFileSync(at('tool.exe'), Buffer.from([0x4d, 0x5a, 0, 0]))
    expect(await readDocument(at('tool.exe'))).toMatch(/cannot read \.exe files/)
    writeFileSync(at('data.csv'), Buffer.from([0x61, 0, 0x62]))
    expect(await readDocument(at('data.csv'))).toMatch(/not a text file/)
  })

  it('cuts very long documents and says how much is left', async () => {
    writeFileSync(at('long.txt'), 'a'.repeat(50_000))
    const text = await readDocument(at('long.txt'))
    expect(text).toMatch(/…\(cut; 10000 more characters\)$/)
  })
})
