import { InputError } from './input.js'

const MAX_MARKDOWN_CHARS = 50_000
const HTML_TAG = /<\/?[a-zA-Z][^>]*>/
const UNSAFE_SCHEME = /^(javascript|data|vbscript):/i

function paragraph(text) {
  const content = parseInline(text)
  return {
    type: 'paragraph',
    attrs: { textAlign: 'left' },
    ...(content.length > 0 ? { content } : {}),
  }
}

function parseInline(text) {
  const nodes = []
  const pattern = /\[([^\]]+)\]\(([^)]+)\)/g
  let last = 0
  let match
  while ((match = pattern.exec(text)) !== null) {
    if (match.index > last) {
      nodes.push({ type: 'text', text: text.slice(last, match.index) })
    }
    const href = match[2].trim()
    if (UNSAFE_SCHEME.test(href) || href.startsWith('//')) {
      throw new InputError('Markdown links must use http, https, mailto, or an in-document path')
    }
    if (href.startsWith('#') || (href.startsWith('/') && !href.startsWith('//'))) {
      nodes.push({ type: 'text', marks: [{ type: 'link', attrs: { href } }], text: match[1] })
    } else {
      try {
        const url = new URL(href)
        if (!['http:', 'https:', 'mailto:'].includes(url.protocol)) {
          throw new InputError('Markdown links must use http, https, or mailto')
        }
      } catch (error) {
        if (error instanceof InputError) throw error
        throw new InputError('Markdown link href is invalid')
      }
      nodes.push({ type: 'text', marks: [{ type: 'link', attrs: { href } }], text: match[1] })
    }
    last = match.index + match[0].length
  }
  if (last < text.length) nodes.push({ type: 'text', text: text.slice(last) })
  return nodes
}

function flushParagraph(lines, nodes) {
  const text = lines.splice(0).join(' ').trim()
  if (text) nodes.push(paragraph(text))
}

function parseList(lines, start, ordered) {
  const items = []
  let index = start
  let taskList = null
  while (index < lines.length) {
    const line = lines[index]
    const bullet = ordered ? line.match(/^(\d+)\.\s+(.*)$/) : line.match(/^[-*]\s+(.*)$/)
    if (!bullet) break
    const rest = ordered ? bullet[2] : bullet[1]
    const task = rest.match(/^\[([ xX])\]\s+(.*)$/)
    const isTask = Boolean(task)
    if (taskList == null) taskList = isTask
    if (isTask !== taskList) break
    if (task) {
      items.push({
        type: 'taskItem',
        attrs: { checked: task[1] !== ' ' },
        content: [paragraph(task[2])],
      })
    } else {
      items.push({
        type: 'listItem',
        content: [paragraph(rest)],
      })
    }
    index += 1
  }
  if (items.length === 0) return { node: null, next: start }
  if (taskList) return { node: { type: 'taskList', content: items }, next: index }
  return {
    node: ordered
      ? { type: 'orderedList', attrs: { start: 1, type: '1' }, content: items }
      : { type: 'bulletList', content: items },
    next: index,
  }
}

export function markdownToTiptap(markdown) {
  if (typeof markdown !== 'string') throw new InputError('Markdown input must be a string')
  if (markdown.length > MAX_MARKDOWN_CHARS) {
    throw new InputError(`Markdown must not exceed ${MAX_MARKDOWN_CHARS} characters`)
  }
  if (HTML_TAG.test(markdown)) throw new InputError('Raw HTML is not allowed in Markdown import')
  if (/^\s*\|.+\|\s*$/m.test(markdown)) throw new InputError('Markdown tables are not supported')
  if (/\[\^[^\]]+\]/.test(markdown)) throw new InputError('Markdown footnotes are not supported')
  if (/!\[[^\]]*\]\([^)]+\)/.test(markdown)) throw new InputError('Markdown images are not supported')

  const lines = markdown.replace(/\r\n/g, '\n').split('\n')
  const content = []
  const paragraphLines = []
  let i = 0
  while (i < lines.length) {
    const line = lines[i]
    if (line.startsWith('```')) {
      flushParagraph(paragraphLines, content)
      const language = line.slice(3).trim()
      if (language && !/^[A-Za-z0-9_+.-]{1,64}$/.test(language)) {
        throw new InputError('Code block language is invalid')
      }
      const body = []
      i += 1
      while (i < lines.length && !lines[i].startsWith('```')) {
        body.push(lines[i])
        i += 1
      }
      if (i >= lines.length) throw new InputError('Unclosed fenced code block')
      const code = body.join('\n')
      content.push({
        type: 'codeBlock',
        attrs: { language: language || null },
        ...(code ? { content: [{ type: 'text', text: code }] } : {}),
      })
      i += 1
      continue
    }
    if (line.trim() === '') {
      flushParagraph(paragraphLines, content)
      i += 1
      continue
    }
    const heading = line.match(/^(#{1,6})\s+(.+)$/)
    if (heading) {
      flushParagraph(paragraphLines, content)
      content.push({
        type: 'heading',
        attrs: { level: heading[1].length, textAlign: 'left' },
        content: parseInline(heading[2].trim()),
      })
      i += 1
      continue
    }
    if (/^[-*]\s+/.test(line) || /^\d+\.\s+/.test(line)) {
      flushParagraph(paragraphLines, content)
      const ordered = /^\d+\.\s+/.test(line)
      const parsed = parseList(lines, i, ordered)
      if (!parsed.node) throw new InputError('List item is invalid')
      content.push(parsed.node)
      i = parsed.next
      continue
    }
    paragraphLines.push(line.trim())
    i += 1
  }
  flushParagraph(paragraphLines, content)
  if (content.length === 0) {
    content.push({ type: 'paragraph', attrs: { textAlign: 'left' } })
  }
  return { type: 'doc', content }
}
