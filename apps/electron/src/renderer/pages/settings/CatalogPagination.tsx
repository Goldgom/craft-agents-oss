import { ChevronLeft, ChevronRight } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'

interface CatalogPaginationProps {
  page: number
  pageSize: number
  total: number
  onPageChange: (page: number) => void
}

export function CatalogPagination({ page, pageSize, total, onPageChange }: CatalogPaginationProps) {
  const { t } = useTranslation()
  const pageCount = Math.max(1, Math.ceil(total / pageSize))
  const safePage = Math.min(page, pageCount)
  if (total <= pageSize) return null

  const start = (safePage - 1) * pageSize + 1
  const end = Math.min(safePage * pageSize, total)
  return (
    <div className="flex items-center justify-between gap-3 border-t border-border/60 px-4 py-2.5">
      <span className="text-xs text-muted-foreground">
        {t('settings.catalog.paginationRange', { start, end, total })}
      </span>
      <div className="flex items-center gap-2">
        <span className="text-xs text-muted-foreground">
          {t('settings.catalog.pageCount', { page: safePage, total: pageCount })}
        </span>
        <Button
          variant="outline"
          size="icon"
          className="h-7 w-7"
          disabled={safePage <= 1}
          aria-label={t('settings.catalog.previousPage')}
          onClick={() => onPageChange(safePage - 1)}
        >
          <ChevronLeft className="h-3.5 w-3.5" />
        </Button>
        <Button
          variant="outline"
          size="icon"
          className="h-7 w-7"
          disabled={safePage >= pageCount}
          aria-label={t('settings.catalog.nextPage')}
          onClick={() => onPageChange(safePage + 1)}
        >
          <ChevronRight className="h-3.5 w-3.5" />
        </Button>
      </div>
    </div>
  )
}
