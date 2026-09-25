"use client"

import { useEffect, useRef, useCallback, type ReactNode } from "react"

interface Ping {
  x: number
  y: number
  born: number
}

export interface SonarGridProps {
  id?: string
  ringWidth?: number
  speed?: number
  amplitude?: number
  pingEvery?: number
  interactive?: boolean
  spacing?: number
  baseOpacity?: number
  color?: string
  pingArea?: [number, number, number, number]
  className?: string
  children?: ReactNode
}

function hexToRgb(hex: string): [number, number, number] {
  const clean = hex.replace(/^#/, "")
  const full =
    clean.length === 3
      ? clean
          .split("")
          .map((c) => c + c)
          .join("")
      : clean
  const n = parseInt(full, 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}

export function SonarGrid({
  id,
  ringWidth = 90,
  speed = 260,
  amplitude = 2.2,
  pingEvery = 2.4,
  interactive = true,
  spacing = 26,
  baseOpacity = 0.28,
  color,
  pingArea = [0, 0, 1, 1],
  className = "",
  children,
}: SonarGridProps) {
  const wrapRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const pingsRef = useRef<Ping[]>([])
  const rafRef = useRef<number>(0)
  const lastPingRef = useRef<number>(0)
  const resolvedColor = useRef<string>(color ?? "#9391f7")

  // Resolve CSS custom property once mounted
  useEffect(() => {
    if (!color) {
      const v = getComputedStyle(document.documentElement)
        .getPropertyValue("--color-primary")
        .trim()
      if (v) resolvedColor.current = v
    } else {
      resolvedColor.current = color
    }
  }, [color])

  const firePing = useCallback(
    (x: number, y: number) => {
      const now = performance.now()
      pingsRef.current.push({ x, y, born: now })
      // Keep only pings younger than 7 s
      pingsRef.current = pingsRef.current.filter((p) => now - p.born < 7000)
    },
    [],
  )

  useEffect(() => {
    const canvas = canvasRef.current
    const wrap = wrapRef.current
    if (!canvas || !wrap) return
    const ctx = canvas.getContext("2d")
    if (!ctx) return

    let W = 0,
      H = 0,
      dpr = 1

    const resize = () => {
      dpr = window.devicePixelRatio || 1
      const rect = wrap.getBoundingClientRect()
      W = rect.width
      H = rect.height
      canvas.width = W * dpr
      canvas.height = H * dpr
      canvas.style.width = `${W}px`
      canvas.style.height = `${H}px`
      ctx.resetTransform()
      ctx.scale(dpr, dpr)
    }
    resize()
    const ro = new ResizeObserver(resize)
    ro.observe(wrap)

    const render = (now: number) => {
      ctx.clearRect(0, 0, W, H)

      // Auto-ping within pingArea
      if (now - lastPingRef.current > pingEvery * 1000) {
        lastPingRef.current = now
        const [x0, y0, x1, y1] = pingArea
        const px = x0 * W + Math.random() * (x1 - x0) * W
        const py = y0 * H + Math.random() * (y1 - y0) * H
        firePing(px, py)
      }

      const [cr, cg, cb] = hexToRgb(resolvedColor.current)
      const maxR = Math.hypot(W, H) * 0.75
      const hw = ringWidth / 2

      // ── Pass 1: dot grid with ring distortion ──────────────────────────
      const startCol = Math.floor(spacing / 2)
      const startRow = Math.floor(spacing / 2)

      for (let col = startCol; col < W + spacing; col += spacing) {
        for (let row = startRow; row < H + spacing; row += spacing) {
          let ox = 0
          let oy = 0
          let boost = 0

          for (const p of pingsRef.current) {
            const age = (now - p.born) / 1000
            const r = age * speed
            if (r > maxR) continue

            const dist = Math.hypot(col - p.x, row - p.y)
            const delta = Math.abs(dist - r)

            if (delta < hw) {
              const peak = 1 - delta / hw
              const fade = 1 - r / maxR
              const str = amplitude * peak * peak * fade

              if (dist > 0.001) {
                ox += ((col - p.x) / dist) * str
                oy += ((row - p.y) / dist) * str
              }
              boost = Math.max(boost, peak * fade * 0.6)
            }
          }

          ctx.beginPath()
          ctx.arc(col + ox, row + oy, 1.25, 0, Math.PI * 2)
          ctx.fillStyle = `rgba(${cr},${cg},${cb},${Math.min(1, baseOpacity + boost)})`
          ctx.fill()
        }
      }

      // ── Pass 2: rings ──────────────────────────────────────────────────
      for (const p of pingsRef.current) {
        const age = (now - p.born) / 1000
        const r = age * speed
        if (r > maxR || r < 1) continue

        const fade = Math.pow(1 - r / maxR, 1.3)

        // Soft outer glow
        ctx.beginPath()
        ctx.arc(p.x, p.y, r, 0, Math.PI * 2)
        ctx.strokeStyle = `rgba(${cr},${cg},${cb},${fade * 0.15})`
        ctx.lineWidth = hw * 1.5
        ctx.stroke()

        // Core bright ring
        ctx.beginPath()
        ctx.arc(p.x, p.y, r, 0, Math.PI * 2)
        ctx.strokeStyle = `rgba(${cr},${cg},${cb},${fade * 0.55})`
        ctx.lineWidth = hw * 0.3
        ctx.stroke()
      }

      rafRef.current = requestAnimationFrame(render)
    }

    rafRef.current = requestAnimationFrame(render)

    return () => {
      cancelAnimationFrame(rafRef.current)
      ro.disconnect()
    }
  }, [speed, ringWidth, amplitude, pingEvery, spacing, baseOpacity, firePing, pingArea])

  const handleClick = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      if (!interactive) return
      const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
      firePing(e.clientX - rect.left, e.clientY - rect.top)
    },
    [interactive, firePing],
  )

  return (
    <div
      id={id}
      ref={wrapRef}
      className={`relative overflow-hidden ${className}`}
      onClick={handleClick}
      style={{ cursor: interactive ? "crosshair" : "default" }}
    >
      <canvas ref={canvasRef} className="absolute inset-0" aria-hidden="true" />
      <div className="relative z-10 flex flex-1 flex-col">{children}</div>
    </div>
  )
}
