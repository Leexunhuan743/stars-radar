async function graphql(token, query, variables) {
  const response = await fetch('https://api.github.com/graphql', {
    method: 'POST',
    headers: {
      'authorization': `Bearer ${token}`,
      'user-agent': 'Stars-Radar',
      'content-type': 'application/json',
    },
    body: JSON.stringify({ query, variables }),
    signal: AbortSignal.timeout(30000),
  })
  if (!response.ok)
    throw new Error(`Could not fetch GitHub Lists: HTTP ${response.status}`)
  const payload = await response.json()
  if (payload.errors?.length)
    throw new Error(`Could not fetch GitHub Lists: ${payload.errors.map(error => error.message).join('; ')}`)
  return payload.data
}

function nextCursor(connection, operation) {
  if (!Array.isArray(connection?.nodes) || typeof connection.pageInfo?.hasNextPage !== 'boolean')
    throw new Error(`Could not fetch ${operation}: invalid GitHub pagination response`)
  if (!connection.pageInfo.hasNextPage)
    return null
  if (!connection.pageInfo.endCursor)
    throw new Error(`Could not fetch ${operation}: missing next-page cursor`)
  return connection.pageInfo.endCursor
}

export async function fetchUserLists(token) {
  const lists = []
  let cursor = null
  do {
    const data = await graphql(token, `query($cursor: String) {
      viewer { lists(first: 50, after: $cursor) {
        nodes { id name description }
        pageInfo { hasNextPage endCursor }
      } }
    }`, { cursor })
    const connection = data?.viewer?.lists
    const next = nextCursor(connection, 'GitHub Lists')
    if (next && next === cursor)
      throw new Error('Could not fetch GitHub Lists: pagination cursor did not advance')
    lists.push(...connection.nodes)
    cursor = next
  } while (cursor)

  const repoToCategories = {}
  const categoriesList = []
  for (const list of lists) {
    if (!list?.id || !list.name)
      throw new Error('Could not fetch GitHub Lists: a list is missing its identity')
    cursor = null
    do {
      const data = await graphql(token, `query($listId: ID!, $cursor: String) {
        node(id: $listId) { ... on UserList {
          items(first: 100, after: $cursor) {
            nodes { ... on Repository { nameWithOwner } }
            pageInfo { hasNextPage endCursor }
          }
        } }
      }`, { listId: list.id, cursor })
      const connection = data?.node?.items
      const next = nextCursor(connection, `items in GitHub List ${list.name}`)
      if (next && next === cursor)
        throw new Error(`Could not fetch GitHub List ${list.name}: pagination cursor did not advance`)
      for (const repo of connection.nodes) {
        if (!repo?.nameWithOwner)
          throw new Error(`Could not fetch GitHub List ${list.name}: a repository is missing its name`)
        const categories = (repoToCategories[repo.nameWithOwner] ||= [])
        if (!categories.includes(list.name))
          categories.push(list.name)
      }
      cursor = next
    } while (cursor)
    categoriesList.push({ name: list.name, description: list.description || '' })
  }
  return { repoToCategories, categoriesList }
}

export function summarizeCategories(categoriesList, repos) {
  const names = new Map(categoriesList.map(category => [category.name, category]))
  for (const repo of Object.values(repos)) {
    for (const name of repo.categories)
      names.set(name, names.get(name) || { name, description: '' })
  }
  return [...names.values()].map((category) => {
    const members = Object.values(repos).filter(repo => repo.categories.includes(category.name))
    return {
      ...category,
      count: members.length,
      topRepos: members.sort((a, b) => b.stars - a.stars).slice(0, 3).map(repo => ({ name: repo.repo, stars: repo.stars })),
    }
  })
}
