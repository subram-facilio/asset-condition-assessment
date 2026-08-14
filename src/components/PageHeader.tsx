import { FText, FButton, FIcon } from '@facilio/dsm-react-wrapper'

interface PageHeaderProps {
  title: string
  description?: string
  showNewButton?: boolean
  newButtonLabel?: string
  onNewClick?: () => void
  onMoreClick?: () => void
  iconGroup?: string
  iconName?: string
}

const PageHeader = ({
  title,
  description,
  showNewButton = true,
  newButtonLabel = 'New Asset',
  onNewClick,
  iconGroup = 'webtabs',
  iconName = 'asset',
}: PageHeaderProps) => {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        padding: 'var(--spacing-section-xsmall) var(--spacing-container-xxlarge)',
        minHeight: '74px',
        backgroundColor: 'var(--colors-background-container)',
        borderBottom: '1px solid var(--colors-border-neutral-base-subtler)',
        // 12px — the icon sits directly beside the title, with no avatar box padding it out.
        gap: 'var(--spacing-container-xlarge)',
      }}
    >
      {/* Bare icon, not an avatar: the flex wrapper only keeps it from shrinking or stretching. */}
      <div style={{ display: 'flex', flexShrink: 0 }}>
        <FIcon
          group={iconGroup}
          name={iconName}
          size={20}
          color=""
          pressable={false}
        />
      </div>

      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          flex: 1,
          minWidth: 0,
          overflow: 'hidden',
        }}
      >
        <FText appearance="headingMed16" styleProps={{ color: 'textMain' }}>
          {title}
        </FText>
        {description && (
          <FText
            appearance="bodyReg14"
            styleProps={{
              color: 'textCaption',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
              display: 'block',
            }}
          >
            {description}
          </FText>
        )}
      </div>

      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 'var(--spacing-container-large)',
          flexShrink: 0,
        }}
      >
        {showNewButton && (
          <FButton
            appearance="primary"
            size="medium"
            icon={{ group: '16px-special-case', name: 'plus' }}
            iconPosition="prefix"
            onClick={onNewClick}
            color='iconPrimaryDefault'
          >
            {newButtonLabel}
          </FButton>
        )}
        {/* <div
          style={{
            width: '1px',
            height: '32px',
            backgroundColor: 'var(--colors-border-neutral-base-subtle)',
            margin: '0 var(--spacing-container-large)',
            alignSelf: 'stretch',
          }}
        />
 
        <FButton
          appearance="tertiary"
          size="medium"
          iconButton
          icon={{ group: 'action', name: 'options-horizontal' }}
          onClick={onMoreClick}
        /> */}
      </div>
    </div>
  )
}

export default PageHeader
