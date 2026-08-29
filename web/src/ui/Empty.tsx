// Composed empty state: icon glyph + heading + guidance + optional actions.
import type { ReactNode } from 'react'
import Icon, { type IconName } from './Icon'

export default function Empty({
  icon,
  title,
  children,
  actions,
}: {
  icon: IconName
  title: string
  children?: ReactNode
  actions?: ReactNode
}) {
  return (
    <div className="empty">
      <div className="glyph">
        <Icon name={icon} size={22} />
      </div>
      <b>{title}</b>
      {children && <div>{children}</div>}
      {actions && <div className="actions">{actions}</div>}
    </div>
  )
}
