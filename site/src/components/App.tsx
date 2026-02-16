import { Leva } from 'leva'
import { MainLayout } from './MainLayout'
import { PageContent } from './PageContent'

export function App() {
  return (
    <MainLayout>
      <Leva hidden />
      <PageContent />
    </MainLayout>
  )
}
