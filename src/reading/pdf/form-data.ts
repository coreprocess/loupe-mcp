/**
 * AcroForm fields of one PDF page, read from the widget annotations pdf.js exposes and grouped by
 * field name: text values, checkbox and radio state, selected list options, signature and button
 * widgets. The geometry stays in PDF user space (points), so the model can relate a widget to the
 * rendered page without the values ever being drawn.
 */
import type { PDFPageProxy } from 'pdfjs-dist/types/src/display/api.js';

/** Widget bounds in PDF user space, `[x1, y1, x2, y2]` in points, plus the widget's own rotation when set. */
type PdfFormWidgetGeometry = {
    rect: [number, number, number, number];
    rotation?: number;
};

/** Placement of one radio widget; `buttonValue` is the export name of that option when pdf.js provides it. */
type PdfFormRadioOptionGeometry = Partial<PdfFormWidgetGeometry> & {
    buttonValue?: string;
};

/** One field of the page's form, discriminated by `kind`. */
export type PdfFormField =
    | { kind: 'checkbox'; name: string; checked: boolean; geometry?: PdfFormWidgetGeometry }
    | { kind: 'text'; name: string; value: string; geometry?: PdfFormWidgetGeometry }
    | { kind: 'dropdown'; name: string; selected: string[]; geometry?: PdfFormWidgetGeometry }
    | { kind: 'radioGroup'; name: string; selected: string | null; optionGeometries: PdfFormRadioOptionGeometry[] }
    | { kind: 'optionList'; name: string; selected: string[]; geometry?: PdfFormWidgetGeometry }
    | { kind: 'signature'; name: string; geometry?: PdfFormWidgetGeometry }
    | { kind: 'button'; name: string; geometry?: PdfFormWidgetGeometry }
    | { kind: 'unknown'; name: string; className: string; geometry?: PdfFormWidgetGeometry };

/** The form fields found on one page; empty for a page without widgets. */
export type PdfFormData = {
    fields: PdfFormField[];
};

/** pdf.js's `AnnotationType.WIDGET`. */
const ANNOTATION_TYPE_WIDGET = 20;

/** A widget annotation as pdf.js returns it: an untyped bag of properties. */
type WidgetData = Record<string, unknown>;

/** Reads the page's widget annotations and folds them into fields; a nameless widget gets a synthetic key. */
export async function readFormData(page: PDFPageProxy): Promise<PdfFormData> {
    // Only widget annotations carry form state; links, stamps and notes are not the form.
    const annotations: unknown[] = await page.getAnnotations({ intent: 'display' });
    const widgets = annotations.filter(
        (annotation): annotation is WidgetData =>
            isRecord(annotation) && annotation.annotationType === ANNOTATION_TYPE_WIDGET
    );
    if (widgets.length === 0) {
        return { fields: [] };
    }

    // Group by field name: radio options share one name, everything else usually stands alone.
    const byName = new Map<string, WidgetData[]>();
    for (const widget of widgets) {
        const key =
            typeof widget.fieldName === 'string' && widget.fieldName.length > 0
                ? widget.fieldName
                : `:_widget_${byName.size}`;
        byName.set(key, [...(byName.get(key) ?? []), widget]);
    }

    const fields: PdfFormField[] = [];
    for (const [name, group] of byName) {
        fields.push(...toFields(name, group));
    }
    return { fields };
}

/** Turns one widget group into fields by its PDF field type (`Tx`, `Btn`, `Ch`, `Sig`). */
function toFields(name: string, widgets: WidgetData[]): PdfFormField[] {
    const first = widgets[0] as WidgetData;
    const fieldType = first.fieldType;

    if (fieldType === 'Tx') {
        const value = typeof first.fieldValue === 'string' ? first.fieldValue : '';
        return [{ kind: 'text', name, value, ...optionalGeometry(first) }];
    }

    if (fieldType === 'Btn') {
        // A group of radio widgets is one field; a lone checkbox or push button stands for itself.
        if (widgets.every((widget) => widget.radioButton === true)) {
            return [
                {
                    kind: 'radioGroup',
                    name,
                    selected: radioSelection(widgets),
                    optionGeometries: widgets.map(radioOptionGeometry),
                },
            ];
        }
        if (widgets.length === 1 && first.checkBox === true) {
            return [{ kind: 'checkbox', name, checked: isCheckboxChecked(first), ...optionalGeometry(first) }];
        }
        if (widgets.length === 1 && first.pushButton === true) {
            return [{ kind: 'button', name, ...optionalGeometry(first) }];
        }
        return widgets
            .filter((widget) => widget.checkBox === true)
            .map((widget) => ({
                kind: 'checkbox' as const,
                name,
                checked: isCheckboxChecked(widget),
                ...optionalGeometry(widget),
            }));
    }

    if (fieldType === 'Ch') {
        const selected = toSelectedStrings(first.fieldValue);
        const kind = first.combo === true ? 'dropdown' : 'optionList';
        return [{ kind, name, selected, ...optionalGeometry(first) }];
    }

    if (fieldType === 'Sig') {
        return [{ kind: 'signature', name, ...optionalGeometry(first) }];
    }

    return [{ kind: 'unknown', name, className: `widget:${String(fieldType)}`, ...optionalGeometry(first) }];
}

/** A non-null object; pdf.js annotations arrive untyped. */
function isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object';
}

/** The widget's rectangle when pdf.js reports four finite numbers, with its rotation when set. */
function readGeometry(widget: WidgetData): PdfFormWidgetGeometry | undefined {
    const rect = widget.rect;
    if (!Array.isArray(rect) || rect.length !== 4 || !rect.every((n) => typeof n === 'number' && Number.isFinite(n))) {
        return undefined;
    }
    const geometry: PdfFormWidgetGeometry = { rect: [rect[0], rect[1], rect[2], rect[3]] };
    if (typeof widget.rotation === 'number' && Number.isFinite(widget.rotation)) {
        geometry.rotation = widget.rotation;
    }
    return geometry;
}

/** The geometry as a spreadable bag, absent when the widget has no usable rectangle. */
function optionalGeometry(widget: WidgetData): { geometry?: PdfFormWidgetGeometry } {
    const geometry = readGeometry(widget);
    return geometry ? { geometry } : {};
}

/** One radio option's placement with its export name when pdf.js provides one. */
function radioOptionGeometry(widget: WidgetData): PdfFormRadioOptionGeometry {
    const geometry = readGeometry(widget) ?? {};
    return typeof widget.buttonValue === 'string' ? { ...geometry, buttonValue: widget.buttonValue } : geometry;
}

/** A checkbox is checked when its value is neither absent nor `Off` and, when an export value exists, matches it. */
function isCheckboxChecked(widget: WidgetData): boolean {
    const value = widget.fieldValue;
    if (typeof value !== 'string' || value === 'Off') {
        return false;
    }
    return typeof widget.exportValue === 'string' ? value === widget.exportValue : true;
}

/** The selected option of a radio group: the shared field value, `Off` meaning none. */
function radioSelection(widgets: WidgetData[]): string | null {
    const value = widgets[0]?.fieldValue;
    return typeof value === 'string' && value !== 'Off' ? value : null;
}

/** pdf.js reports a choice value as a string, an array or a scalar; all become the list of selected names. */
function toSelectedStrings(value: unknown): string[] {
    if (value == null) {
        return [];
    }
    if (typeof value === 'string') {
        return value.length > 0 ? [value] : [];
    }
    if (typeof value === 'number' || typeof value === 'boolean') {
        return [String(value)];
    }
    if (Array.isArray(value)) {
        return value.filter((entry): entry is string => typeof entry === 'string');
    }
    return [];
}
