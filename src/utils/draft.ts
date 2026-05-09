import { getCollection, type CollectionEntry } from 'astro:content'

export function isDraftPost(post: Pick<CollectionEntry<'posts'>, 'id'>) {
  return post.id
    .split('/')
    .some((segment) => segment.replace(/\.(md|mdx)$/i, '').startsWith('_'))
}

/**
 * Get all posts, filtering out posts whose filenames or directory names start with _.
 */
export async function getFilteredPosts() {
  const posts = await getCollection('posts')
  return posts.filter((post: CollectionEntry<'posts'>) => !isDraftPost(post))
}

/**
 * Get all posts sorted by publication date, filtering out draft posts.
 */
export async function getSortedFilteredPosts() {
  const posts = await getFilteredPosts()
  return posts.sort(
    (a: CollectionEntry<'posts'>, b: CollectionEntry<'posts'>) => b.data.pubDate.valueOf() - a.data.pubDate.valueOf()
  )
}
