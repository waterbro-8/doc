import { open } from 'node:fs/promises'
import { resolve } from 'node:path'

export const MAX_DOCUMENT_INPUT_BYTES = 1_000_000

export class InputError extends Error {}

function inputSizeError(maximumBytes) {
  return new InputError(`Input exceeds ${maximumBytes} bytes`)
}

export async function readStreamWithLimit(stream, maximumBytes) {
  const chunks = []
  let total = 0
  for await (const chunk of stream) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    total += buffer.byteLength
    if (total > maximumBytes) throw inputSizeError(maximumBytes)
    chunks.push(buffer)
  }
  return Buffer.concat(chunks).toString('utf8')
}

async function readLimitedFile(path, cwd, stdin) {
  if (path === '-') {
    return readStreamWithLimit(stdin, MAX_DOCUMENT_INPUT_BYTES)
  }
  const absolutePath = resolve(cwd, path)
  let file
  try {
    file = await open(absolutePath, 'r')
    const fileStat = await file.stat()
    if (!fileStat.isFile()) throw new InputError(`Document input is not a regular file: ${absolutePath}`)
    if (fileStat.size > MAX_DOCUMENT_INPUT_BYTES) throw inputSizeError(MAX_DOCUMENT_INPUT_BYTES)
    return await readStreamWithLimit(file.createReadStream({ autoClose: false }), MAX_DOCUMENT_INPUT_BYTES)
  } catch (error) {
    if (error instanceof InputError) throw error
    throw new InputError(`Unable to read document input: ${absolutePath}`)
  } finally {
    await file?.close()
  }
}

export async function readMarkdownInput(path, cwd, stdin) {
  return readLimitedFile(path, cwd, stdin)
}

export async function readDocumentInput(path, cwd, stdin) {
  const content = await readLimitedFile(path, cwd, stdin)

  let value
  try {
    value = JSON.parse(content)
  } catch {
    throw new InputError('Document content must be valid TipTap JSON')
  }
  if (
    value == null ||
    Array.isArray(value) ||
    typeof value !== 'object' ||
    value.type !== 'doc' ||
    (value.content !== undefined && !Array.isArray(value.content))
  ) {
    throw new InputError('Document content must be a TipTap document object with type "doc"')
  }
  return value
}

async function readHiddenTty(stream, promptStream) {
  promptStream.write('API token: ')
  const originalRawMode = stream.isRaw
  stream.setEncoding('utf8')
  stream.setRawMode(true)
  stream.resume()

  return new Promise((resolvePromise, rejectPromise) => {
    let value = ''

    function cleanup() {
      stream.off('data', onData)
      stream.off('error', onError)
      stream.setRawMode(Boolean(originalRawMode))
      stream.pause()
      promptStream.write('\n')
    }

    function finish() {
      cleanup()
      resolvePromise(value)
    }

    function fail(error) {
      cleanup()
      rejectPromise(error)
    }

    function onError(error) {
      fail(error)
    }

    function onData(chunk) {
      for (const character of chunk) {
        if (character === '\r' || character === '\n' || character === '\u0004') {
          finish()
          return
        }
        if (character === '\u0003') {
          fail(new InputError('Token input cancelled'))
          return
        }
        if (character === '\u007f' || character === '\b') {
          value = value.slice(0, -1)
          continue
        }
        if (Buffer.byteLength(value + character) > 4096) {
          fail(inputSizeError(4096))
          return
        }
        value += character
      }
    }

    stream.on('data', onData)
    stream.on('error', onError)
  })
}

export async function readSecretToken(stdin, promptStream) {
  if (stdin.isTTY && typeof stdin.setRawMode === 'function') {
    return readHiddenTty(stdin, promptStream)
  }
  return readStreamWithLimit(stdin, 4096)
}
