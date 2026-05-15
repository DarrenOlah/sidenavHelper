// Canonical upstreams — also used as fallback for dev, tests, and
// non-GitHub-Pages hosts (custom domains, etc.) where we can't infer.
const FALLBACK_HELPER_URL = 'https://darrenolah.github.io/sidenavHelper/'
const FALLBACK_REPO_URL = 'https://github.com/DarrenOlah/sidenavHelper'
const FALLBACK_HERO_BASE = 'https://darrenolah.github.io/heroHelper/'

// Sister app on the same GitHub account is assumed to keep this repo name.
const HERO_REPO_NAME = 'heroHelper'

interface DerivedUrls {
  helperUrl: string
  repoUrl: string
  heroBase: string
}

function deriveUrls(): DerivedUrls {
  if (typeof window === 'undefined') {
    return {
      helperUrl: FALLBACK_HELPER_URL,
      repoUrl: FALLBACK_REPO_URL,
      heroBase: FALLBACK_HERO_BASE,
    }
  }

  const { hostname, pathname, origin } = window.location
  const ghMatch = hostname.match(/^([^.]+)\.github\.io$/i)
  if (ghMatch) {
    const user = ghMatch[1]
    const repo = pathname.split('/').filter(Boolean)[0]
    if (repo) {
      return {
        helperUrl: `${origin}/${repo}/`,
        repoUrl: `https://github.com/${user}/${repo}`,
        heroBase: `${origin}/${HERO_REPO_NAME}/`,
      }
    }
  }

  return {
    helperUrl: FALLBACK_HELPER_URL,
    repoUrl: FALLBACK_REPO_URL,
    heroBase: FALLBACK_HERO_BASE,
  }
}

const urls = deriveUrls()
export const HELPER_URL = urls.helperUrl
export const REPO_URL = urls.repoUrl
export const HERO_IMAGE_URL = `${urls.heroBase}#/image`
export const HERO_VIDEO_URL = `${urls.heroBase}#/video`
