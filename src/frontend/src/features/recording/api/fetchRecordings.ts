import { fetchApi } from '@/api/fetchApi'
import { RecordingApi } from './fetchRecording'

export type RecordingsPage = {
  count: number
  next: string | null
  previous: string | null
  results: RecordingApi[]
}

export const fetchRecordings = () => {
  return fetchApi<RecordingsPage>('/recordings/')
}
