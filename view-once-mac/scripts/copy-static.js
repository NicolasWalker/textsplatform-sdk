const fs = require('fs')
const path = require('path')

const src = path.join(__dirname, '..', 'src', 'renderer.html')
const dest = path.join(__dirname, '..', 'dist', 'renderer.html')

fs.mkdirSync(path.dirname(dest), { recursive: true })
fs.copyFileSync(src, dest)
console.log('Copied renderer.html to dist/')
