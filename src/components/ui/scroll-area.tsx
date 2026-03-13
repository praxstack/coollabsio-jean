import * as React from 'react'

import { cn } from '@/lib/utils'

interface ScrollAreaProps extends React.HTMLAttributes<HTMLDivElement> {
  viewportRef?: React.RefObject<HTMLDivElement | null>
  onScroll?: (event: React.UIEvent<HTMLDivElement>) => void
  ref?: React.Ref<HTMLDivElement>
}

function ScrollArea({
  className,
  children,
  viewportRef,
  onScroll,
  ref,
  ...props
}: ScrollAreaProps) {
  return (
    <div
      ref={ref}
      data-slot="scroll-area"
      className={cn('relative overflow-hidden', className)}
      {...props}
    >
      <div
        ref={viewportRef}
        data-slot="scroll-area-viewport"
        className="size-full overflow-y-auto overflow-x-hidden rounded-[inherit] overscroll-y-contain focus-visible:ring-ring/50 transition-[color,box-shadow] outline-none focus-visible:ring-[3px] focus-visible:outline-1"
        onScroll={onScroll}
      >
        {children}
      </div>
    </div>
  )
}

// Kept for API compat — native scrollbar replaces Radix scrollbar
function ScrollBar(_props: Record<string, unknown>) {
  return null
}

export { ScrollArea, ScrollBar }
