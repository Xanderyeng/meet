import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { useTitle } from 'hoofd'
import { css } from '@/styled-system/css'
import { VStack, HStack } from '@/styled-system/jsx'
import { UserAware, useUser } from '@/features/auth'
import { Screen } from '@/layout/Screen'
import { Text, LinkButton } from '@/primitives'
import { ErrorScreen } from '@/components/ErrorScreen'
import { LoadingScreen } from '@/components/LoadingScreen'
import { mediaUrl } from '@/api/mediaUrl'
import { formatDate } from '@/utils/formatDate'
import { fetchRecordings } from '../api/fetchRecordings'
import { RecordingStatus } from '@/features/recording'
import { RecordingApi } from '../api/fetchRecording'
import { routes } from '@/routes'

const APP_TITLE = import.meta.env.VITE_APP_TITLE ?? ''

const statusLabel: Record<RecordingStatus, string> = {
  [RecordingStatus.Saved]: 'ready',
  [RecordingStatus.NotificationSucceed]: 'ready',
  [RecordingStatus.FailedToStop]: 'ready',
  [RecordingStatus.Active]: 'recording',
  [RecordingStatus.Initiated]: 'processing',
  [RecordingStatus.Stopped]: 'processing',
  [RecordingStatus.Aborted]: 'failed',
  [RecordingStatus.FailedToStart]: 'failed',
}

const isDownloadable = (status: RecordingStatus) =>
  status === RecordingStatus.Saved ||
  status === RecordingStatus.NotificationSucceed ||
  status === RecordingStatus.FailedToStop

export const RecordingsList = () => {
  const { t } = useTranslation('recording')
  const { isLoggedIn, isLoading: isAuthLoading } = useUser()

  useTitle(`${APP_TITLE} - ${t('list.title')}`)

  const { data, isLoading, isError } = useQuery({
    queryKey: ['recordings'],
    queryFn: fetchRecordings,
    retry: false,
    enabled: isLoggedIn === true,
  })

  if (isLoggedIn === undefined || isAuthLoading) {
    return <LoadingScreen />
  }

  if (!isLoggedIn) {
    return (
      <ErrorScreen
        title={t('authentication.title')}
        body={t('authentication.body')}
      />
    )
  }

  if (isLoading) {
    return <LoadingScreen />
  }

  if (isError) {
    return <ErrorScreen title={t('error.title')} body={t('error.body')} />
  }

  const recordings = data?.results ?? []

  return (
    <UserAware>
      <Screen headerTitle={t('list.title')}>
        <div
          className={css({
            maxWidth: '100%',
            width: '38rem',
            margin: 'auto',
            paddingX: '2rem',
            paddingY: '2rem',
          })}
        >
          {recordings.length === 0 ? (
            <VStack gap="4" alignItems="center" paddingY="4rem">
              <img
                src="/assets/intro-slider/4.png"
                alt=""
                className={css({ maxHeight: '180px', opacity: 0.5 })}
              />
              <Text centered>{t('list.empty')}</Text>
            </VStack>
          ) : (
            <VStack gap="3" alignItems="stretch">
              {recordings.map((recording: RecordingApi) => {
                const downloadable = isDownloadable(recording.status)
                const expired = recording.is_expired
                const label = statusLabel[recording.status] ?? 'processing'
                return (
                  <div
                    key={recording.id}
                    className={css({
                      border: '1px solid',
                      borderColor: 'greyscale.200',
                      borderRadius: '8px',
                      padding: '1rem 1.25rem',
                      backgroundColor: 'white',
                    })}
                  >
                    <HStack justifyContent="space-between" alignItems="center" gap="3">
                      <VStack gap="1" alignItems="flex-start" flex="1" minWidth="0">
                        <Text
                          className={css({
                            fontWeight: 600,
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                            whiteSpace: 'nowrap',
                            maxWidth: '100%',
                          })}
                        >
                          {recording.room.name}
                        </Text>
                        <Text variant="smNote">
                          {formatDate(recording.created_at, 'YYYY-MM-DD HH:mm')}
                        </Text>
                        <span
                          className={css({
                            display: 'inline-block',
                            fontSize: '12px',
                            fontWeight: 500,
                            paddingX: '0.4rem',
                            paddingY: '0.15rem',
                            borderRadius: '4px',
                            backgroundColor:
                              label === 'ready'
                                ? 'success.100'
                                : label === 'failed'
                                  ? 'danger.100'
                                  : 'greyscale.100',
                            color:
                              label === 'ready'
                                ? 'success.700'
                                : label === 'failed'
                                  ? 'danger.700'
                                  : 'greyscale.700',
                          })}
                        >
                          {t(`list.status.${label}`)}
                        </span>
                      </VStack>
                      <HStack gap="2" flexShrink="0">
                        <LinkButton
                          href={routes.recordingDownload.to!(recording.id)}
                          variant="secondary"
                          size="sm"
                        >
                          {t('list.viewButton')}
                        </LinkButton>
                        {downloadable && !expired && (
                          <LinkButton
                            href={mediaUrl(recording.key)}
                            download={`${recording.room.name}-${formatDate(recording.created_at)}`}
                            variant="primary"
                            size="sm"
                          >
                            {t('success.button')}
                          </LinkButton>
                        )}
                      </HStack>
                    </HStack>
                  </div>
                )
              })}
            </VStack>
          )}
          {data && data.count > recordings.length && (
            <Text
              centered
              variant="smNote"
              className={css({ marginTop: '1.5rem' })}
            >
              {t('list.showingCount', {
                shown: recordings.length,
                total: data.count,
              })}
            </Text>
          )}
        </div>
      </Screen>
    </UserAware>
  )
}
