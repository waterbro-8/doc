import assert from 'node:assert/strict'
import test from 'node:test'
import { markdownToTiptap } from '../src/markdown-to-tiptap.js'

test('converts headings, lists, tasks, code, and links', () => {
  const doc = markdownToTiptap(`# Title

A paragraph with [docs](https://example.com).

- item
- [x] done

1. one

\`\`\`js
const n = 1
\`\`\`
`)
  assert.equal(doc.type, 'doc')
  assert.equal(doc.content[0].type, 'heading')
  assert.equal(doc.content[0].attrs.level, 1)
  assert.equal(doc.content[1].type, 'paragraph')
  assert.equal(doc.content[1].content[1].marks[0].type, 'link')
  assert.equal(doc.content[2].type, 'bulletList')
  assert.equal(doc.content[3].type, 'taskList')
  assert.equal(doc.content[3].content[0].attrs.checked, true)
  assert.equal(doc.content[4].type, 'orderedList')
  assert.equal(doc.content[5].type, 'codeBlock')
  assert.equal(doc.content[5].attrs.language, 'js')
})

test('rejects raw HTML, images, javascript links, and tables', () => {
  assert.throws(() => markdownToTiptap('<script>x</script>'), /Raw HTML/)
  assert.throws(() => markdownToTiptap('![alt](https://example.com/a.png)'), /images/)
  assert.throws(() => markdownToTiptap('[x](javascript:alert(1))'), /http, https, mailto/)
  assert.throws(() => markdownToTiptap('| a | b |\n| --- | --- |'), /tables/)
})
