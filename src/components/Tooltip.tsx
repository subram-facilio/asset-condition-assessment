import { useState, useRef, useEffect, useCallback } from 'react'
import { createPortal } from 'react-dom'

const OFFSET = 8

interface TooltipProps {
  content: string
  trigger?: 'hover' | 'click'
  placement?: 'top' | 'bottom' | 'left' | 'right' | 'topRight' | 'bottomRight' | 'leftRight' | 'leftBottom'
  maxWidth?: number
  delay?: number
  /** Keep the trigger rendered but never open the tooltip (e.g. text that isn't truncated). */
  disabled?: boolean
  /** Let the trigger fill its parent, so a child that clips its text has a width to clip against. */
  fullWidth?: boolean
  children: React.ReactNode
}

const Tooltip = ({
  content,
  trigger = 'hover',
  placement = 'top',
  maxWidth,
  delay = 0,
  disabled = false,
  fullWidth = false,
  children,
}: TooltipProps) => {
  const [visible, setVisible] = useState(false)
  const [coords, setCoords] = useState({ top: 0, left: 0 })
  const ref = useRef<HTMLDivElement>(null)
  const delayRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const updateCoords = useCallback(() => {
    if (!ref.current) return
    const rect = ref.current.getBoundingClientRect()
    const scrollX = window.scrollX
    const scrollY = window.scrollY
    if (placement === 'top') {
      setCoords({
        top: rect.top + scrollY - OFFSET,
        left: rect.left + scrollX + rect.width / 2,
      })
    } else if (placement === 'bottom') {
      setCoords({
        top: rect.bottom + scrollY + OFFSET,
        left: rect.left + scrollX + rect.width / 2,
      })
    } else if (placement === 'right') {
      setCoords({
        top: rect.top + scrollY + rect.height / 2,
        left: rect.right + scrollX + OFFSET,
      })
    } else if (placement === 'topRight') {
      setCoords({
        top: rect.top + scrollY + rect.height / 2,
        left: rect.left + scrollX - OFFSET,
      })
    } else if (placement === 'bottomRight') {
      setCoords({
        top: rect.bottom + scrollY + OFFSET,
        left: rect.right + scrollX + OFFSET,
      })
    } else if (placement === 'leftRight') {
      setCoords({
        top: rect.top + scrollY + rect.height / 2,
        left: rect.left + scrollX - OFFSET,
      })
    } else if (placement === 'leftBottom') {
      setCoords({
        top: rect.bottom + scrollY + OFFSET,
        left: rect.left + scrollX - OFFSET,
      })
    }
  }, [placement])

  useEffect(() => {
    if (visible) updateCoords()
  }, [visible, updateCoords])

  const showTooltip = useCallback(() => {
    if (trigger !== 'hover' || disabled) return
    if (delayRef.current) clearTimeout(delayRef.current)
    if (delay <= 0) {
      setVisible(true)
      return
    }
    delayRef.current = setTimeout(() => setVisible(true), delay)
  }, [trigger, delay, disabled])

  const hideTooltip = useCallback(() => {
    if (delayRef.current) {
      clearTimeout(delayRef.current)
      delayRef.current = null
    }
    setVisible(false)
  }, [])

  useEffect(() => {
    if (trigger !== 'click' || !visible) return
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setVisible(false)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [trigger, visible])

  const getTransform = () => {
    if (placement === 'top') return 'translate(-50%, -100%)'
    if (placement === 'bottom') return 'translate(-50%, 0)'
    if (placement === 'right') return 'translate(0, -50%)'
    if (placement === 'topRight') return 'translate(0, -100%)'
    if (placement === 'bottomRight') return 'translate(0, 0)'
    if (placement === 'leftRight') return 'translate(-100%, -50%)'
    if (placement === 'leftBottom') return 'translate(-100%, 0)'
    return 'translate(-100%, -50%)'
  }

  const tooltipEl = visible && !disabled
    ? createPortal(
        <div
          style={{
            position: 'absolute',
            top: coords.top,
            left: coords.left,
            transform: getTransform(),
            backgroundColor: '#384a62',
            color: '#edf5ff',
            fontSize: '10px',
            lineHeight: '16px',
            fontFamily: 'Roboto, sans-serif',
            padding: '4px 8px',
            borderRadius: '2px',
            whiteSpace: maxWidth ? 'normal' : 'nowrap',
            maxWidth: maxWidth ? `${maxWidth}px` : undefined,
            textAlign: 'center',
            zIndex: 10000,
            boxShadow:
              '0px 1px 2px rgba(5,16,30,0.25), 0px 2px 4px rgba(5,16,30,0.1)',
            pointerEvents: trigger === 'click' ? 'auto' : 'none',
          }}
        >
          {content}
          <div
            style={{
              position: 'absolute',
              width: 0,
              height: 0,
              borderLeft: '4px solid transparent',
              borderRight: '4px solid transparent',
              borderTop: '4px solid transparent',
              borderBottom: '4px solid transparent',
              ...(placement === 'top' && {
                left: '50%',
                top: '100%',
                transform: 'translateX(-50%)',
                borderTop: '4px solid #384a62',
              }),
              ...(placement === 'bottom' && {
                left: '50%',
                bottom: '100%',
                transform: 'translateX(-50%)',
                borderBottom: '4px solid #384a62',
              }),
              ...(placement === 'right' && {
                left: 0,
                top: '50%',
                transform: 'translate(-100%, -50%)',
                borderRight: '4px solid #384a62',
              }),
              ...(placement === 'left' && {
                right: 0,
                top: '50%',
                transform: 'translate(100%, -50%)',
                borderLeft: '4px solid #384a62',
              }),
            }}
          />
        </div>,
        document.body,
      )
    : null

  return (
    <>
      <div
        ref={ref}
        style={
          fullWidth
            ? { display: 'flex', alignItems: 'center', width: '100%', minWidth: 0 }
            : { display: 'inline-flex', alignItems: 'center' }
        }
        onMouseEnter={trigger === 'hover' ? showTooltip : undefined}
        onMouseLeave={trigger === 'hover' ? hideTooltip : undefined}
        onClick={
          trigger === 'click' && !disabled
            ? (e) => {
                e.stopPropagation()
                setVisible((v) => !v)
              }
            : undefined
        }
      >
        {children}
      </div>
      {tooltipEl}
    </>
  )
}

export default Tooltip
