// Mock backend for the standalone relay-agent test: reads a prompt on stdin
// and writes a fixed reply to stdout.
let data = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => { data += chunk })
process.stdin.on('end', () => {
  if (!data.includes('请审查')) {
    console.error('unexpected prompt (missing expected content)')
    process.exit(2)
  }
  console.log('（mock 后端回复）已审查：无问题，风险：无。')
})
