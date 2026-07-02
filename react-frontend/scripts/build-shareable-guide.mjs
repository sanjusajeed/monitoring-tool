import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { marked } from 'marked'

const here = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(here, '..', '..')
const docsDir = path.join(repoRoot, 'docs')
const imagesDir = path.join(docsDir, 'images')
const inputPath = path.join(docsDir, 'USER_GUIDE.md')
const outputPath = path.join(docsDir, 'Application_Monitor_User_Guide.html')

let markdown = fs.readFileSync(inputPath, 'utf8')

markdown = markdown.replace(/\]\(images\/([^)]+\.svg)\)/g, (match, fileName) => {
  const imagePath = path.join(imagesDir, fileName)
  if (!fs.existsSync(imagePath)) return match
  const svg = fs.readFileSync(imagePath, 'utf8')
  return `](data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)})`
})

const body = marked.parse(markdown)

const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Application Monitor User Guide</title>
  <style>
    body {
      font-family: Arial, Helvetica, sans-serif;
      line-height: 1.6;
      color: #1f2937;
      max-width: 1100px;
      margin: 0 auto;
      padding: 32px;
      background: #fff;
    }
    h1, h2, h3 { color: #111827; line-height: 1.25; }
    h1 { border-bottom: 1px solid #e5e7eb; padding-bottom: 10px; }
    h2 { border-bottom: 1px solid #eef2f7; padding-bottom: 8px; margin-top: 34px; }
    table { border-collapse: collapse; width: 100%; margin: 14px 0; font-size: 14px; }
    th, td { border: 1px solid #e5e7eb; padding: 8px 10px; text-align: left; vertical-align: top; }
    th { background: #f9fafb; }
    img { max-width: 100%; border: 1px solid #e5e7eb; border-radius: 12px; margin: 10px 0 18px; }
    code { background: #f3f4f6; padding: 2px 5px; border-radius: 4px; }
    hr { border: none; border-top: 1px solid #e5e7eb; margin: 28px 0; }
    @media print {
      body { max-width: none; padding: 18px; }
      img { break-inside: avoid; }
      h2, h3 { break-after: avoid; }
    }
  </style>
</head>
<body>
${body}
</body>
</html>
`

fs.writeFileSync(outputPath, html)
console.log(outputPath)
