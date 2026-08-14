import { FText, FButton } from '@facilio/dsm-react-wrapper'

interface PaginationProps {
  currentPage: number
  totalPages: number
  onPageChange: (page: number) => void
}

const Pagination = ({ currentPage, totalPages, onPageChange }: PaginationProps) => {
  const getPageNumbers = (): (number | '...')[] => {
    if (totalPages <= 5) {
      return Array.from({ length: totalPages }, (_, i) => i + 1)
    }

    const pages: (number | '...')[] = []

    if (currentPage <= 3) {
      pages.push(1, 2, 3, '...', totalPages)
    } else if (currentPage >= totalPages - 2) {
      pages.push(1, '...', totalPages - 2, totalPages - 1, totalPages)
    } else {
      pages.push(1, '...', currentPage, '...', totalPages)
    }

    return pages
  }

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 'var(--spacing-container-medium)',
      }}
    >
      <FButton
        appearance="tertiary"
        size="small"
        iconButton
        icon={{ group: 'dsm', name: 'chevron-left' }}
        onClick={() => onPageChange(currentPage - 1)}
        disabled={currentPage === 1}
      />

      {getPageNumbers().map((page, index) =>
        page === '...' ? (
          <div
            key={`ellipsis-${index}`}
            style={{
              width: '24px',
              height: '24px',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <FText
              appearance="bodyReg14"
              styleProps={{ color: 'textMain', textAlign: 'center' }}
            >
              ...
            </FText>
          </div>
        ) : (
          <div
            key={page}
            onClick={() => onPageChange(page)}
            style={{
              width: '24px',
              height: '24px',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              borderRadius: 'var(--border-small)',
              cursor: 'pointer',
              backgroundColor:
                currentPage === page
                  ? 'var(--colors-background-selection)'
                  : 'var(--colors-background-canvas)',
              border: currentPage === page
                ? '1px solid var(--colors-border-primary-default)'
                : '1px solid var(--colors-border-none)',
            }}
          >
            <FText
              appearance="bodyReg14"
              styleProps={{ color: 'textMain', textAlign: 'center' }}
            >
              {page}
            </FText>
          </div>
        ),
      )}

      <FButton
        appearance="tertiary"
        size="small"
        iconButton
        icon={{ group: 'dsm', name: 'chevron-right' }}
        onClick={() => onPageChange(currentPage + 1)}
        disabled={currentPage === totalPages}
      />
    </div>
  )
}

export default Pagination
