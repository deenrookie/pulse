// CodeMirror 6 wrapper for plugin source / JSON fixtures. The view owns the
// document once mounted; external `value` changes are applied only when they
// differ from the current doc so programmatic updates never fight typing.
// Theming goes through the app's CSS variables so all three themes work.
import { useEffect, useRef } from 'react'
import { EditorView, keymap, lineNumbers, highlightActiveLine, drawSelection } from '@codemirror/view'
import { EditorState, Compartment } from '@codemirror/state'
import { indentWithTab, defaultKeymap } from '@codemirror/commands'
import { javascript } from '@codemirror/lang-javascript'
import { json } from '@codemirror/lang-json'
import { syntaxHighlighting, HighlightStyle, bracketMatching, indentUnit } from '@codemirror/language'
import { tags as t } from '@lezer/highlight'

const languageComp = new Compartment()

// shared look for both modes: gutters/cursor/selection must follow the app
// theme — CodeMirror's built-in defaults are light-theme and glare on dark.
const cmBase = EditorView.theme({
  '&': { backgroundColor: 'var(--bg-input)', color: 'var(--text)', fontSize: '12.5px' },
  '.cm-scroller': { fontFamily: 'var(--mono)', lineHeight: '1.65', padding: '6px 0' },
  '.cm-content': { caretColor: 'var(--accent)' },
  '.cm-gutters': {
    backgroundColor: 'var(--bg)', color: 'var(--text-faint)',
    border: 'none', borderRight: '1px solid var(--border)', fontSize: '10.5px', minWidth: '38px',
  },
  '.cm-activeLine': { backgroundColor: 'rgb(var(--accent-rgb) / .05)' },
  '.cm-activeLineGutter': { backgroundColor: 'transparent', color: 'var(--text-muted)' },
  '&.cm-focused': { outline: 'none' },
  '.cm-selectionBackground, &.cm-focused .cm-selectionBackground': {
    backgroundColor: 'rgb(var(--accent-rgb) / .32) !important',
  },
  '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--accent)', borderLeftWidth: '2px' },
  '.cm-matchingBracket': {
    backgroundColor: 'transparent', outline: '1px solid rgb(var(--accent-rgb) / .5)', color: 'inherit',
  },
})

// default mode: the editor fills its pane and scrolls inside
const cmFill = EditorView.theme({
  '&': { height: '100%' },
  '.cm-scroller': { overflow: 'auto' },
})

// auto-height mode: the editor grows with its content (Samples showcase)
const cmAuto = EditorView.theme({
  '.cm-scroller': { overflow: 'visible' },
})

// restrained token palette — a monitoring tool reads first, decorates second
const cmHighlight = HighlightStyle.define([
  { tag: t.comment, color: 'var(--text-faint)', fontStyle: 'italic' },
  { tag: [t.keyword, t.moduleKeyword, t.controlKeyword], color: 'var(--accent)' },
  { tag: [t.string, t.special(t.string)], color: 'var(--ok)' },
  { tag: [t.number, t.bool], color: 'var(--warn)' },
  { tag: t.regexp, color: 'var(--danger)' },
  { tag: [t.definitionKeyword, t.modifier], color: 'var(--accent)' },
  { tag: [t.function(t.variableName), t.function(t.propertyName)], color: 'var(--accent)' },
  { tag: [t.propertyName, t.labelName], color: 'var(--text-muted)' },
  { tag: t.invalid, color: 'var(--danger)' },
])

export default function CodeEditor({
  value,
  onChange,
  language = 'js',
  readOnly = false,
  autoHeight = false,
}: {
  value: string
  onChange: (next: string) => void
  /** 'js' for plugin sources, 'json' for test fixtures */
  language?: 'js' | 'json'
  /** read-only display (Samples tab) — no cursor, no editing */
  readOnly?: boolean
  /** grow with content instead of filling the pane */
  autoHeight?: boolean
}) {
  const host = useRef<HTMLDivElement>(null)
  const viewRef = useRef<EditorView | null>(null)
  const onChangeRef = useRef(onChange)
  onChangeRef.current = onChange

  useEffect(() => {
    if (!host.current) return
    const state = EditorState.create({
      doc: value,
      extensions: [
        lineNumbers(),
        highlightActiveLine(),
        drawSelection(),
        bracketMatching(),
        indentUnit.of('  '),
        EditorView.lineWrapping,
        keymap.of([indentWithTab, ...defaultKeymap]),
        languageComp.of(language === 'js' ? javascript() : json()),
        cmBase,
        autoHeight ? cmAuto : cmFill,
        // readOnly (state) keeps the DOM editable so native selection and
        // copy work — EditorView.editable.of(false) would kill both
        EditorState.readOnly.of(readOnly),
        syntaxHighlighting(cmHighlight),
        EditorView.updateListener.of((u) => {
          if (u.docChanged) onChangeRef.current(u.state.doc.toString())
        }),
      ],
    })
    const view = new EditorView({ state, parent: host.current })
    viewRef.current = view
    return () => {
      view.destroy()
      viewRef.current = null
    }
    // mount once — language/value changes are handled by the effects below
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    const view = viewRef.current
    if (view && value !== view.state.doc.toString()) {
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: value } })
    }
  }, [value])

  useEffect(() => {
    viewRef.current?.dispatch({
      effects: languageComp.reconfigure(language === 'js' ? javascript() : json()),
    })
  }, [language])

  return <div ref={host} className="cm-host" />
}
