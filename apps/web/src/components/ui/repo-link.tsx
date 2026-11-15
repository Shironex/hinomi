import { Link } from '@tanstack/react-router'
import { cn } from '@/lib/utils'

/**
 * A repo name that opens the repo page. Use it wherever a repo is named outside a link that
 * already covers its row. `children` replaces the full name when a shorter label is shown.
 */
export function RepoLink({
  repo,
  className,
  children,
}: {
  repo: { id: number; fullName: string }
  className?: string
  children?: React.ReactNode
}) {
  return (
    <Link
      to="/repos/$id"
      params={{ id: String(repo.id) }}
      title={repo.fullName}
      className={cn('rounded-sm hover:underline', className)}
    >
      {children ?? repo.fullName}
    </Link>
  )
}
