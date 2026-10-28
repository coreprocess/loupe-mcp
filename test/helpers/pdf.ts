/**
 * Minimal PDFs for tests: pages with one line of Helvetica text each, optionally a filled-in form
 * text field on the first page. Offsets in the cross-reference table are computed, so pdf.js opens
 * them without repair.
 */
export const makePdf = (pageTexts: string[], options: { formField?: { name: string; value: string } } = {}): Buffer => {
    const objects: string[] = [];
    const add = (body: string): number => {
        objects.push(body);
        return objects.length;
    };
    const catalog = add('');
    const pagesId = add('');
    const font = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
    const field = options.formField
        ? add(
              `<< /Type /Annot /Subtype /Widget /FT /Tx /T (${options.formField.name}) /V (${options.formField.value}) /Rect [72 600 300 620] /F 4 >>`
          )
        : undefined;
    const pageIds: number[] = [];
    for (const [index, text] of pageTexts.entries()) {
        const stream = `BT /F1 18 Tf 72 720 Td (${text}) Tj ET`;
        const content = add(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
        const annots = index === 0 && field ? ` /Annots [${field} 0 R]` : '';
        pageIds.push(
            add(
                `<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${font} 0 R >> >> /Contents ${content} 0 R${annots} >>`
            )
        );
    }
    objects[catalog - 1] =
        `<< /Type /Catalog /Pages ${pagesId} 0 R${field ? ` /AcroForm << /Fields [${field} 0 R] >>` : ''} >>`;
    objects[pagesId - 1] =
        `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${pageIds.length} >>`;

    let pdf = '%PDF-1.7\n';
    const offsets: number[] = [];
    for (const [index, body] of objects.entries()) {
        offsets.push(Buffer.byteLength(pdf, 'latin1'));
        pdf += `${index + 1} 0 obj\n${body}\nendobj\n`;
    }
    const xref = Buffer.byteLength(pdf, 'latin1');
    pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
    for (const offset of offsets) pdf += `${String(offset).padStart(10, '0')} 00000 n \n`;
    pdf += `trailer\n<< /Size ${objects.length + 1} /Root ${catalog} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
    return Buffer.from(pdf, 'latin1');
};
