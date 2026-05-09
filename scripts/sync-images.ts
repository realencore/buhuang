#!/usr/bin/env tsx

import { createHash, createHmac } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync
} from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import sharp from 'sharp'

type Env = Record<string, string>

type ImageReference = {
  match: string
  target: string
  alt: string
  index: number
  kind: 'obsidian' | 'markdown'
}

type UploadResult = {
  url: string
  key: string
  sha256: string
  bytes: number
}

const repoRoot = process.cwd()
const postsRoot = path.join(repoRoot, 'src/content/posts')
const manifestPath = path.join(repoRoot, '.image-sync/manifest.json')
const imageExtensions = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif', '.avif'])

const env = loadEnv()
const dryRun = process.argv.includes('--dry-run')

async function main() {
  if (!existsSync(postsRoot)) {
    console.error(`Image sync could not find posts directory: ${relative(postsRoot)}`)
    process.exit(1)
  }

  const markdownFiles = listFiles(postsRoot).filter((file) => file.endsWith('.md') || file.endsWith('.mdx'))
  const candidates = markdownFiles.flatMap((file) =>
    extractImageReferences(readFileSync(file, 'utf8')).map((reference) => ({ file, reference }))
  )

  if (candidates.length === 0) {
    console.log('Image sync: no local or Obsidian image references found.')
    return
  }

  validateEnv()

  const manifest = readManifest()
  const attachmentDirs = getAttachmentDirs()
  const filesChanged = new Set<string>()
  let uploadCount = 0

  for (const markdownFile of markdownFiles) {
    const originalContent = readFileSync(markdownFile, 'utf8')
    const references = extractImageReferences(originalContent)

    if (references.length === 0) {
      continue
    }

    let nextContent = originalContent
    const replacements = new Map<string, string>()

    for (const reference of references) {
      const sourceFile = resolveImage(markdownFile, reference.target, attachmentDirs)

      if (!sourceFile) {
        throw new Error(
          [
            `Could not find image "${reference.target}" referenced by ${relative(markdownFile)}.`,
            `Looked next to the post and in: ${attachmentDirs.map(relative).join(', ')}`
          ].join('\n')
        )
      }

      const upload = await prepareAndUpload(sourceFile, markdownFile)
      uploadCount += upload.bytes > 0 ? 1 : 0

      manifest[relative(sourceFile)] = {
        ...upload,
        source: relative(sourceFile),
        post: relative(markdownFile),
        updatedAt: new Date().toISOString()
      }

      const replacementAlt = reference.alt || path.basename(sourceFile, path.extname(sourceFile))
      replacements.set(reference.match, `![${escapeAlt(replacementAlt)}](${upload.url})`)
    }

    for (const [from, to] of replacements) {
      nextContent = nextContent.split(from).join(to)
    }

    if (nextContent !== originalContent) {
      if (!dryRun) {
        writeFileSync(markdownFile, nextContent)
      }
      filesChanged.add(markdownFile)
    }
  }

  if (!dryRun) {
    writeManifest(manifest)
  }

  const changedList = [...filesChanged].map(relative)
  console.log(
    [
      `Image sync${dryRun ? ' check' : ''}: processed ${candidates.length} reference${candidates.length === 1 ? '' : 's'}.`,
      uploadCount > 0 ? `Uploaded ${uploadCount} new image${uploadCount === 1 ? '' : 's'}.` : 'No new uploads needed.',
      changedList.length > 0
        ? `${dryRun ? 'Would update' : 'Updated'}: ${changedList.join(', ')}`
        : 'Markdown already used hosted URLs.'
    ].join(' ')
  )
}

function loadEnv(): Env {
  const result: Env = { ...process.env } as Env

  for (const fileName of ['.env.local', '.env']) {
    const filePath = path.join(repoRoot, fileName)

    if (!existsSync(filePath)) {
      continue
    }

    const lines = readFileSync(filePath, 'utf8').split(/\r?\n/)

    for (const line of lines) {
      const trimmed = line.trim()

      if (!trimmed || trimmed.startsWith('#')) {
        continue
      }

      const separator = trimmed.indexOf('=')

      if (separator === -1) {
        continue
      }

      const key = trimmed.slice(0, separator).trim()
      const rawValue = trimmed.slice(separator + 1).trim()
      result[key] = rawValue.replace(/^["']|["']$/g, '')
    }
  }

  return result
}

function validateEnv() {
  if (dryRun) {
    return
  }

  const required = [
    'R2_ACCOUNT_ID',
    'R2_ACCESS_KEY_ID',
    'R2_SECRET_ACCESS_KEY',
    'R2_BUCKET',
    'IMAGE_BASE_URL'
  ]
  const missing = required.filter((key) => !env[key])

  if (missing.length > 0) {
    throw new Error(
      [
        `Image sync needs Cloudflare R2 config before it can upload: ${missing.join(', ')}`,
        'Copy .env.example to .env.local and fill in the values.'
      ].join('\n')
    )
  }
}

function getAttachmentDirs() {
  const configured = env.IMAGE_ATTACHMENT_DIRS?.split(',').map((item) => item.trim()).filter(Boolean) ?? []
  const defaults = ['src/content/posts/_assets', 'src/content/posts/_attachments']
  const dirs = configured.length > 0 ? configured : defaults

  return dirs.map((dir) => path.resolve(repoRoot, dir)).filter((dir) => existsSync(dir))
}

function extractImageReferences(content: string): ImageReference[] {
  const references: ImageReference[] = []
  const obsidianPattern = /!\[\[([^\]|#?]+)(?:[|#?][^\]]*)?\]\]/g
  const markdownPattern =
    /!\[([^\]]*)\]\((?!https?:\/\/|data:|#)(<?[^)\s]+(?:\s[^)]*)?\.(?:png|jpe?g|webp|gif|avif)>?)(?:\s+["'][^"']*["'])?\)/gi

  for (const match of content.matchAll(obsidianPattern)) {
    const target = match[1]?.trim()

    if (!target || !isImageTarget(target)) {
      continue
    }

    references.push({
      match: match[0],
      target,
      alt: path.basename(target, path.extname(target)),
      index: match.index ?? 0,
      kind: 'obsidian'
    })
  }

  for (const match of content.matchAll(markdownPattern)) {
    const target = normalizeMarkdownTarget(match[2] ?? '')

    if (!target || !isImageTarget(target)) {
      continue
    }

    references.push({
      match: match[0],
      target,
      alt: match[1] ?? '',
      index: match.index ?? 0,
      kind: 'markdown'
    })
  }

  return references.sort((a, b) => a.index - b.index)
}

function normalizeMarkdownTarget(target: string) {
  return decodeURIComponent(target.trim().replace(/^<|>$/g, ''))
}

function isImageTarget(target: string) {
  return imageExtensions.has(path.extname(target).toLowerCase())
}

function resolveImage(markdownFile: string, target: string, attachmentDirs: string[]) {
  const normalizedTarget = normalizeMarkdownTarget(target)
  const candidates = [
    path.resolve(path.dirname(markdownFile), normalizedTarget),
    path.resolve(postsRoot, normalizedTarget),
    ...attachmentDirs.map((dir) => path.resolve(dir, normalizedTarget))
  ]

  for (const candidate of candidates) {
    if (existsSync(candidate) && statSync(candidate).isFile()) {
      return candidate
    }
  }

  const basename = path.basename(normalizedTarget)

  for (const dir of [path.dirname(markdownFile), ...attachmentDirs]) {
    const found = findByBasename(dir, basename)

    if (found) {
      return found
    }
  }

  return null
}

function findByBasename(dir: string, basename: string): string | null {
  if (!existsSync(dir)) {
    return null
  }

  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name)

    if (entry.isFile() && entry.name === basename) {
      return fullPath
    }

    if (entry.isDirectory()) {
      const nested = findByBasename(fullPath, basename)

      if (nested) {
        return nested
      }
    }
  }

  return null
}

async function prepareAndUpload(sourceFile: string, markdownFile: string): Promise<UploadResult> {
  const optimized = await optimizeImage(sourceFile)
  const sha256 = createHash('sha256').update(optimized.buffer).digest('hex')
  const key = buildObjectKey(markdownFile, sha256, optimized.ext)
  const imageBaseUrl = normalizeBaseUrl(env.IMAGE_BASE_URL ?? 'https://img.example.com')
  const url = `${imageBaseUrl.replace(/\/$/, '')}/${key}`

  if (dryRun) {
    return { url, key, sha256, bytes: 0 }
  }

  const exists = await objectExists(key)

  if (!exists) {
    await putObject(key, optimized.buffer, optimized.contentType)
    return { url, key, sha256, bytes: optimized.buffer.byteLength }
  }

  return { url, key, sha256, bytes: 0 }
}

async function optimizeImage(sourceFile: string) {
  const ext = path.extname(sourceFile).toLowerCase()
  const source = readFileSync(sourceFile)
  const maxWidth = Number.parseInt(env.IMAGE_MAX_WIDTH ?? '2400', 10)
  const quality = Number.parseInt(env.IMAGE_QUALITY ?? '82', 10)

  if (ext === '.gif' || ext === '.avif') {
    return {
      buffer: source,
      ext: ext.slice(1),
      contentType: ext === '.gif' ? 'image/gif' : 'image/avif'
    }
  }

  let pipeline = sharp(source).rotate().resize({ width: maxWidth, withoutEnlargement: true })

  if (ext === '.png') {
    pipeline = pipeline.png({ compressionLevel: 9, quality })
  } else if (ext === '.webp') {
    pipeline = pipeline.webp({ quality })
  } else {
    pipeline = pipeline.jpeg({ quality, mozjpeg: true })
  }

  const outputExt = ext === '.png' || ext === '.webp' ? ext.slice(1) : 'jpg'

  return {
    buffer: await pipeline.toBuffer(),
    ext: outputExt,
    contentType: `image/${outputExt === 'jpg' ? 'jpeg' : outputExt}`
  }
}

function buildObjectKey(markdownFile: string, sha256: string, ext: string) {
  const relativePost = path.relative(postsRoot, markdownFile)
  const parsed = path.parse(relativePost)
  const prefix = env.IMAGE_PREFIX ?? 'blog'
  const postDir = parsed.dir.split(path.sep).filter(Boolean).join('/')
  const postSlug = parsed.name.replace(/^_+/, '')
  const keyParts = [prefix, postDir, postSlug, `${sha256.slice(0, 12)}.${ext}`].filter(Boolean)

  return keyParts.join('/')
}

async function objectExists(key: string) {
  const response = await signedFetch('HEAD', key)

  if (response.status === 404) {
    return false
  }

  if (!response.ok) {
    const detail = await probeObjectError(key)
    throw new Error(`R2 HEAD failed for ${key}: ${response.status} ${response.statusText}${detail}`)
  }

  return true
}

async function probeObjectError(key: string) {
  const response = await signedFetch('GET', key)
  const text = await response.text()

  return text ? `\n${text}` : ''
}

async function putObject(key: string, body: Buffer, contentType: string) {
  const response = await signedFetch('PUT', key, body, contentType)

  if (!response.ok) {
    throw new Error(`R2 PUT failed for ${key}: ${response.status} ${response.statusText}\n${await response.text()}`)
  }
}

async function signedFetch(method: 'GET' | 'HEAD' | 'PUT', key: string, body?: Buffer, contentType = '') {
  const endpoint = normalizeBaseUrl(env.R2_ENDPOINT || `${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`)
  const endpointUrl = new URL(endpoint)
  const host = endpointUrl.host
  const endpointPath = endpointUrl.pathname.replace(/^\/|\/$/g, '')
  const bucketFromEndpoint = endpointPath === env.R2_BUCKET ? endpointPath : ''
  const pathname = `/${bucketFromEndpoint || env.R2_BUCKET}/${key}`
  const url = `${endpointUrl.protocol}//${host}${pathname}`
  const now = new Date()
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '')
  const dateStamp = amzDate.slice(0, 8)
  const payloadHash = body ? createHash('sha256').update(body).digest('hex') : createHash('sha256').update('').digest('hex')

  const headers: Record<string, string> = {
    host,
    'x-amz-content-sha256': payloadHash,
    'x-amz-date': amzDate
  }

  if (contentType) {
    headers['content-type'] = contentType
  }

  const signedHeaders = Object.keys(headers).sort().join(';')
  const canonicalHeaders = Object.keys(headers)
    .sort()
    .map((name) => `${name}:${headers[name]}\n`)
    .join('')
  const canonicalRequest = [method, encodePath(pathname), '', canonicalHeaders, signedHeaders, payloadHash].join('\n')
  const credentialScope = `${dateStamp}/auto/s3/aws4_request`
  const stringToSign = [
    'AWS4-HMAC-SHA256',
    amzDate,
    credentialScope,
    createHash('sha256').update(canonicalRequest).digest('hex')
  ].join('\n')
  const signingKey = getSignatureKey(env.R2_SECRET_ACCESS_KEY, dateStamp, 'auto', 's3')
  const signature = createHmac('sha256', signingKey).update(stringToSign).digest('hex')

  headers.authorization = [
    `AWS4-HMAC-SHA256 Credential=${env.R2_ACCESS_KEY_ID}/${credentialScope}`,
    `SignedHeaders=${signedHeaders}`,
    `Signature=${signature}`
  ].join(', ')

  return fetch(url, {
    method,
    headers,
    body
  })
}

function encodePath(value: string) {
  return value
    .split('/')
    .map((part) => encodeURIComponent(part))
    .join('/')
}

function getSignatureKey(secret: string, dateStamp: string, regionName: string, serviceName: string) {
  const kDate = createHmac('sha256', `AWS4${secret}`).update(dateStamp).digest()
  const kRegion = createHmac('sha256', kDate).update(regionName).digest()
  const kService = createHmac('sha256', kRegion).update(serviceName).digest()

  return createHmac('sha256', kService).update('aws4_request').digest()
}

function listFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const fullPath = path.join(dir, entry.name)

    if (entry.isDirectory()) {
      return listFiles(fullPath)
    }

    return entry.isFile() ? [fullPath] : []
  })
}

function readManifest(): Record<string, Record<string, string | number>> {
  if (!existsSync(manifestPath)) {
    return {}
  }

  return JSON.parse(readFileSync(manifestPath, 'utf8'))
}

function writeManifest(manifest: Record<string, Record<string, string | number>>) {
  mkdirSync(path.dirname(manifestPath), { recursive: true })
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
}

function escapeAlt(value: string) {
  return value.replace(/\]/g, '\\]')
}

function normalizeBaseUrl(value: string) {
  return /^https?:\/\//i.test(value) ? value : `https://${value}`
}

function relative(filePath: string) {
  return path.relative(repoRoot, filePath) || '.'
}

main().catch((error: unknown) => {
  if (error instanceof Error) {
    console.error(error.message)
    const cause = (error as Error & { cause?: unknown }).cause

    if (cause) {
      console.error(cause)
    }
  } else {
    console.error(error)
  }
  process.exit(1)
})
