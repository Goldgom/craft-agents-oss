import { cn } from '@/lib/utils'

export function AgentAvatar({ avatar, name, className }: { avatar: string; name: string; className?: string }) {
  const isImage = /^data:image\/(?:png|jpe?g|webp);base64,/.test(avatar)
  return <span className={cn('inline-flex size-10 shrink-0 items-center justify-center overflow-hidden rounded-xl bg-primary/10 text-xl text-primary ring-1 ring-primary/10', className)}>
    {isImage ? <img className="size-full object-cover" src={avatar} alt={name} /> : <span aria-hidden="true">{avatar || name.slice(0, 1)}</span>}
  </span>
}
