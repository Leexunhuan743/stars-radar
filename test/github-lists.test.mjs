import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { fetchUserLists, summarizeCategories } from '../scripts/github-lists.js'

const realFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = realFetch
})
const page = (nodes, endCursor = null) => ({ nodes, pageInfo: { hasNextPage: endCursor !== null, endCursor } })
function stub(responses) {
  const requests = []
  globalThis.fetch = async (_url, options) => {
    requests.push(JSON.parse(options.body))
    const response = responses.shift()
    assert.ok(response, 'unexpected GraphQL request')
    return response instanceof Response ? response : Response.json(response)
  }
  return requests
}

test('all lists and all member pages contribute categories', async () => {
  const requests = stub([
    { data: { viewer: { lists: page([{ id: 'one', name: '阅读', description: '笔记工具' }], 'lists-next') } } },
    { data: { viewer: { lists: page([{ id: 'two', name: '工具' }]) } } },
    { data: { node: { items: page([{ nameWithOwner: 'acme/reader' }], 'items-next') } } },
    { data: { node: { items: page([{ nameWithOwner: 'acme/cli' }]) } } },
    { data: { node: { items: page([{ nameWithOwner: 'acme/cli' }]) } } },
  ])
  const result = await fetchUserLists('test-token')
  assert.deepEqual(result.repoToCategories, { 'acme/reader': ['阅读'], 'acme/cli': ['阅读', '工具'] })
  assert.equal(requests[1].variables.cursor, 'lists-next')
  assert.equal(requests[3].variables.cursor, 'items-next')
  assert.equal(requests[4].variables.cursor, null)
})

test('an account without lists is a successful empty result', async () => {
  stub([{ data: { viewer: { lists: page([]) } } }])
  assert.deepEqual(await fetchUserLists('test-token'), { repoToCategories: {}, categoriesList: [] })
})

test('HTTP and GraphQL failures stop category synchronization', async () => {
  stub([new Response('Forbidden', { status: 403 })])
  await assert.rejects(fetchUserLists('test-token'), /HTTP 403/)
  stub([{ data: { viewer: { lists: page([]) } }, errors: [{ message: 'permission denied' }] }])
  await assert.rejects(fetchUserLists('test-token'), /permission denied/)
})

test('partial item results and missing pagination are rejected', async () => {
  stub([
    { data: { viewer: { lists: page([{ id: 'one', name: 'tools' }]) } } },
    { data: { node: null } },
  ])
  await assert.rejects(fetchUserLists('test-token'), /items in GitHub List tools/)
  stub([{ data: { viewer: { lists: { nodes: [] } } } }])
  await assert.rejects(fetchUserLists('test-token'), /pagination/)
})

test('a repeating cursor cannot truncate lists or loop forever', async () => {
  stub([
    { data: { viewer: { lists: page([], 'same') } } },
    { data: { viewer: { lists: page([], 'same') } } },
  ])
  await assert.rejects(fetchUserLists('test-token'), /did not advance/)
})

test('category counts use current stars and expose the uncategorized bucket', () => {
  const result = summarizeCategories([{ name: 'empty', description: 'kept' }], {
    'acme/a': { repo: 'acme/a', stars: 10, categories: ['everything-else'] },
    'acme/b': { repo: 'acme/b', stars: 20, categories: ['everything-else'] },
  })
  assert.deepEqual(result, [
    { name: 'empty', description: 'kept', count: 0, topRepos: [] },
    { name: 'everything-else', description: '', count: 2, topRepos: [{ name: 'acme/b', stars: 20 }, { name: 'acme/a', stars: 10 }] },
  ])
})
