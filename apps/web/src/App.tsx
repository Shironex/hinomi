import { Button } from '@/components/ui/button'

export function App() {
  return (
    <main className="flex min-h-svh flex-col items-center justify-center gap-4 p-6 text-center">
      <h1 className="text-3xl font-semibold tracking-tight">Hinomi</h1>
      <p className="text-muted-foreground">Early development. Nothing to watch yet.</p>
      <Button asChild variant="outline">
        <a href="https://github.com/Shironex/hinomi/blob/main/docs/spec.md">Read the spec</a>
      </Button>
    </main>
  )
}
