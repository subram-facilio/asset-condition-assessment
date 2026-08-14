import React, { useMemo } from 'react'

interface AvatarProps {
  name: string
  size?: number
  /** Opt into the sky/cloud gradient palette (vertical gradients picked by
   *  name hash) instead of the flat blue sphere. */
  gradient?: boolean
}

// Glossy 3D sphere palette — a radial highlight + mid + shadow tone per hue,
// picked by name hash so a given name keeps the same sphere colour. Deep and
// saturated enough that white text always reads, so this doesn't need a
// light/dark theme variant like the `gradient` palette below.
const SPHERES: Array<{ highlight: string; mid: string; shadow: string }> = [
  { highlight: '#b48cff', mid: '#7c3aed', shadow: '#3b0f70' }, // violet
  { highlight: '#7fb2ff', mid: '#2f6fed', shadow: '#0d2c66' }, // blue
  { highlight: '#6fe3d8', mid: '#16a394', shadow: '#04443d' }, // teal
  { highlight: '#ffa8c9', mid: '#e8497d', shadow: '#6b1030' }, // rose
  { highlight: '#ffd08a', mid: '#f2892e', shadow: '#7a3300' }, // amber
  { highlight: '#9be29b', mid: '#3fa54a', shadow: '#0f4a17' }, // green
]

// Soft three-stop gradient palettes (custom colours — not theme tokens). A
// light, airy set for light mode and a deeper, muted set for dark mode so the
// avatars look at home in both. Same length + order, so a given name keeps the
// same hue family across themes.
const LIGHT_GRADIENTS: string[] = [
  'linear-gradient(160deg, #d7e9f7 0%, #ededeb 50%, #fdf1e3 100%)', // blue → cream
  'linear-gradient(160deg, #e2def6 0%, #e7e1ef 50%, #d9e6fb 100%)', // lilac → blue
  'linear-gradient(160deg, #f5dbe6 0%, #efe0ec 50%, #e2def6 100%)', // pink → lilac
  'linear-gradient(160deg, #fbe2d2 0%, #f9dedd 50%, #f5dbe6 100%)', // peach → pink
  'linear-gradient(160deg, #d2e2f7 0%, #dfe0f2 50%, #ece0f4 100%)', // sky → lavender
  'linear-gradient(160deg, #d6ede0 0%, #d4e5ec 50%, #d2e2f7 100%)', // mint → sky
  'linear-gradient(160deg, #e6e1f5 0%, #ede4f2 50%, #f5dbe6 100%)', // lavender → blush
  'linear-gradient(160deg, #f6f0d2 0%, #e6eed9 50%, #d6ede0 100%)', // lemon → mint
]
const DARK_GRADIENTS: string[] = [
  'linear-gradient(160deg, #2b3a55 0%, #2c4a55 50%, #2e5650 100%)', // blue → teal
  'linear-gradient(160deg, #3a3360 0%, #393f68 50%, #2f4f6e 100%)', // indigo → blue
  'linear-gradient(160deg, #4a3358 0%, #443566 50%, #393f68 100%)', // plum → indigo
  'linear-gradient(160deg, #5a3b44 0%, #4d3356 50%, #3a3360 100%)', // rosewood → plum
  'linear-gradient(160deg, #2f5168 0%, #2e4a64 50%, #3a3f68 100%)', // teal → indigo
  'linear-gradient(160deg, #2f5246 0%, #2d5258 50%, #2f4f6e 100%)', // green → blue
  'linear-gradient(160deg, #393f68 0%, #2f4f6e 50%, #2e5650 100%)', // indigo → teal
  'linear-gradient(160deg, #4a3358 0%, #5a3b44 50%, #3a3360 100%)', // plum → rosewood
]
const LIGHT_TEXT = 'rgba(15,23,42,0.7)'
const DARK_TEXT = 'rgba(255,255,255,0.92)'

const hashName = (name: string): number => {
  let hash = 0
  for (let i = 0; i < name.length; i++) {
    hash = name.charCodeAt(i) + ((hash << 5) - hash)
  }
  return Math.abs(hash)
}

// Watch the <html data-theme> attribute so the gradient set swaps live when the
// user toggles the theme (no reload).
const useIsDarkTheme = (): boolean => {
  const [dark, setDark] = React.useState(
    () =>
      typeof document !== 'undefined' &&
      document.documentElement.getAttribute('data-theme') === 'dark',
  )
  React.useEffect(() => {
    if (typeof document === 'undefined') return
    const root = document.documentElement
    const update = () =>
      setDark(root.getAttribute('data-theme') === 'dark')
    update()
    const mo = new MutationObserver(update)
    mo.observe(root, { attributes: true, attributeFilter: ['data-theme'] })
    return () => mo.disconnect()
  }, [])
  return dark
}

/**
 * Get initials from name based on the following logic:
 * 1. If name has first and last name, return first letter of each
 * 2. If name has only first name with 2+ letters, return first 2 letters
 * 3. Otherwise, return first letter of first name
 */
const getInitials = (name: string): string => {
  if (!name || name.trim().length === 0) {
    return '?'
  }

  const trimmedName = name.trim()
  return trimmedName[0].toUpperCase()
}

// Every avatar uses the same violet sphere — a single consistent brand look
// rather than a per-name hash of hues.
const getSphere = () => SPHERES[0]

const Avatar: React.FC<AvatarProps> = ({
  name,
  size = 32,
  gradient = false,
}) => {
  const isDark = useIsDarkTheme()
  const initials = useMemo(() => getInitials(name), [name])
  const sphere = getSphere()
  const grad = useMemo(() => {
    if (!gradient) return null
    const set = isDark ? DARK_GRADIENTS : LIGHT_GRADIENTS
    return {
      bg: set[hashName(name) % set.length],
      text: isDark ? DARK_TEXT : LIGHT_TEXT,
    }
  }, [name, gradient, isDark])

  // Calculate font size based on avatar size
  let fontSize = Math.floor(size * 0.5)
  fontSize = fontSize > 16 ? 16 : fontSize
  return (
    <div
      className="rounded-full"
      style={{
        width: `${size}px`,
        height: `${size}px`,
        display: 'flex',
        justifyContent: 'center',
        alignItems: 'center',
        borderRadius: '100px',
        ...(grad
          ? { background: grad.bg }
          : {
              // Glossy 3D sphere: a soft white sheen (top-left) layered over a
              // highlight → mid → shadow radial body, plus inset rim shading
              // for the "ball" depth cue.
              background: `radial-gradient(circle at 30% 22%, rgba(255,255,255,0.65) 0%, rgba(255,255,255,0) 45%), radial-gradient(120% 120% at 32% 26%, ${sphere.highlight} 0%, ${sphere.mid} 45%, ${sphere.shadow} 100%)`,
              boxShadow:
                'inset -3px -3px 6px rgba(0,0,0,0.35), inset 2px 2px 4px rgba(255,255,255,0.2)',
            }),
      }}
    >
      {grad ? (
        <span
          style={{
            fontSize: `${fontSize}px`,
            lineHeight: 0,
            display: 'block',
            fontWeight: 500,
            color: grad.text,
          }}
        >
          {initials}
        </span>
      ) : (
        <span
          style={{
            fontSize: `${fontSize}px`,
            lineHeight: 0,
            display: 'block',
            fontWeight: 600,
            color: 'rgba(255,255,255,0.95)',
            textShadow: '0 1px 2px rgba(0,0,0,0.35)',
          }}
        >
          {initials}
        </span>
      )}
    </div>
  )
}

export default Avatar
