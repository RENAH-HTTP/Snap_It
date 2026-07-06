---
name: Snap It
colors:
  surface: '#131314'
  surface-dim: '#131314'
  surface-bright: '#3a393a'
  surface-container-lowest: '#0e0e0f'
  surface-container-low: '#1c1b1c'
  surface-container: '#201f20'
  surface-container-high: '#2a2a2b'
  surface-container-highest: '#353436'
  on-surface: '#e5e2e3'
  on-surface-variant: '#d4c0d7'
  inverse-surface: '#e5e2e3'
  inverse-on-surface: '#313031'
  outline: '#9d8ba0'
  outline-variant: '#504254'
  surface-tint: '#ebb2ff'
  primary: '#ebb2ff'
  on-primary: '#520072'
  primary-container: '#bc13fe'
  on-primary-container: '#ffffff'
  inverse-primary: '#9800d0'
  secondary: '#e6feff'
  on-secondary: '#003739'
  secondary-container: '#00f4fe'
  on-secondary-container: '#006c71'
  tertiary: '#ffb1c3'
  on-tertiary: '#66002c'
  tertiary-container: '#e8006e'
  on-tertiary-container: '#ffffff'
  error: '#ffb4ab'
  on-error: '#690005'
  error-container: '#93000a'
  on-error-container: '#ffdad6'
  primary-fixed: '#f8d8ff'
  primary-fixed-dim: '#ebb2ff'
  on-primary-fixed: '#320047'
  on-primary-fixed-variant: '#74009f'
  secondary-fixed: '#63f7ff'
  secondary-fixed-dim: '#00dce5'
  on-secondary-fixed: '#002021'
  on-secondary-fixed-variant: '#004f53'
  tertiary-fixed: '#ffd9e0'
  tertiary-fixed-dim: '#ffb1c3'
  on-tertiary-fixed: '#3f0019'
  on-tertiary-fixed-variant: '#8f0041'
  background: '#131314'
  on-background: '#e5e2e3'
  surface-variant: '#353436'
typography:
  display-lg:
    fontFamily: Sora
    fontSize: 48px
    fontWeight: '800'
    lineHeight: 56px
    letterSpacing: -0.02em
  headline-lg:
    fontFamily: Sora
    fontSize: 32px
    fontWeight: '700'
    lineHeight: 40px
  headline-lg-mobile:
    fontFamily: Sora
    fontSize: 24px
    fontWeight: '700'
    lineHeight: 32px
  title-md:
    fontFamily: Sora
    fontSize: 20px
    fontWeight: '600'
    lineHeight: 28px
  body-lg:
    fontFamily: Hanken Grotesk
    fontSize: 18px
    fontWeight: '400'
    lineHeight: 28px
  body-md:
    fontFamily: Hanken Grotesk
    fontSize: 16px
    fontWeight: '400'
    lineHeight: 24px
  label-md:
    fontFamily: Geist
    fontSize: 14px
    fontWeight: '500'
    lineHeight: 20px
    letterSpacing: 0.05em
  label-sm:
    fontFamily: Geist
    fontSize: 12px
    fontWeight: '600'
    lineHeight: 16px
    letterSpacing: 0.1em
rounded:
  sm: 0.25rem
  DEFAULT: 0.5rem
  md: 0.75rem
  lg: 1rem
  xl: 1.5rem
  full: 9999px
spacing:
  unit: 8px
  container-margin: 20px
  gutter: 16px
  stack-sm: 12px
  stack-md: 24px
  stack-lg: 48px
---

## Brand & Style
The design system is built for an adventurous and tech-forward music exploration experience. The personality is high-energy, playful, and "collectible," treating every track, artist, and playlist as a digital artifact or trading card. 

The visual style is **Neon Glassmorphism**. It utilizes deep obsidian backgrounds to make vibrant electric purple and neon cyan accents pop. Interfaces are layered with frosted transparency, subtle inner glows, and high-contrast borders to create a sense of tactile depth. The "collectible" feel is achieved through consistent card ratios, holographic-inspired gradients, and micro-interactions that mimic physical discovery.

## Colors
The palette is rooted in a "Deep Obsidian" base to emphasize the luminous quality of the primary and secondary colors. 

- **Primary (Electric Purple):** Used for core actions, active states, and primary branding elements.
- **Secondary (Neon Cyan):** Used for secondary actions, data visualizations, and "active" status indicators.
- **Tertiary (Cyber Pink):** Reserved for high-alert interactions, "likes," or special limited-edition collectible markers.
- **Surface Colors:** Deep greys and translucent blacks are used for card backgrounds to maintain legibility while preserving the glass effect.

## Typography
The typography system uses three distinct fonts to balance character with technical precision. 

- **Sora** provides a bold, geometric presence for headlines and display text, emphasizing the app's tech-forward identity.
- **Hanken Grotesk** serves as the primary body face, offering high legibility with a clean, contemporary feel.
- **Geist** is used for labels and metadata to lean into the developer-adjacent, technical aesthetic of the "Snap" mechanism. 

All display text should be set with tight letter-spacing to feel "packed" and impactful. Labels use increased tracking for better readability against dark, translucent backgrounds.

## Layout & Spacing
This design system employs a **Fluid Grid** model centered on a base-8 spacing scale. 

- **Mobile:** 4-column grid with 20px side margins and 16px gutters.
- **Desktop:** 12-column grid with a maximum content width of 1440px. 
- **The "Card" Unit:** Most content is encapsulated in cards. Spacing within cards is tighter (12px - 16px) to maintain the "collectible" feel, while the vertical rhythm between sections is more generous (48px) to allow the neon elements room to breathe without creating visual clutter.

## Elevation & Depth
Depth is not communicated through traditional shadows, but through **Tonal Stacking** and **Backdrop Blurs**.

- **Level 0 (Background):** Deep Obsidian (#0A0A0B).
- **Level 1 (Cards/Containers):** Glassmorphic surfaces using 15% white opacity with a 16px backdrop blur. Borders are 1px solid at 20% opacity.
- **Level 2 (Active/Hover):** Inner glows using the primary primary color (Electric Purple) at 30% opacity to suggest the element is "energized."
- **Level 3 (Modals/Popovers):** Higher contrast borders (40% opacity) and a darker backdrop dim to focus the user’s attention.

## Shapes
The shape language balances modern sleekness with approachable curves. UI elements use a standard **0.5rem (8px)** radius to feel structured yet smooth. 

Special "Collectible" cards use a slightly more aggressive **1rem (16px)** radius to distinguish them from standard UI controls. Interactive elements like buttons and input fields follow the standard 8px radius to maintain a consistent, technical feel.

## Components
- **Buttons:** Primary buttons are solid Electric Purple with a subtle 2px Neon Cyan outer glow on hover. Secondary buttons use a glassmorphic fill with a 1px Cyan border.
- **Collectible Cards:** These feature a 1px gradient border (Purple to Cyan). The background uses the standard glassmorphism effect. On hover, the card should scale slightly (1.02x) and increase the intensity of the backdrop blur.
- **Chips/Tags:** Small, pill-shaped elements with 10% Cyan fill and 100% Cyan text for metadata like "Genre" or "BPM."
- **Inputs:** Dark obsidian backgrounds with 1px borders that glow Cyan when focused. Labels use the `label-sm` style in Geist for a technical look.
- **Progress Bars:** Seek bars and loading states utilize a gradient from Purple to Cyan, with a "laser" tip (white glow) at the leading edge of the progress.
- **Music Player:** A floating glassmorphic bar at the bottom of the viewport, utilizing heavy backdrop blurs to ensure visibility over scrolling content.