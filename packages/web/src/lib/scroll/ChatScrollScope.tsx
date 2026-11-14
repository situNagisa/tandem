/**
 * 消息区滚动控制器的 React 绑定。
 *
 * `useChatScrollController` 在 ChatView 里创建实例并绑定 `.chat-scroll`；
 * `ChatScrollScope` 把同一个实例提供给子树（MessageList、工具卡等按需订阅），
 * 不改变 DOM 结构。
 */
import {
  createContext,
  useContext,
  useLayoutEffect,
  useState,
  type ReactNode,
  type RefObject,
} from 'react'
import { createChatScrollController, type ChatScrollController } from './chatScrollController'

const ChatScrollContext = createContext<ChatScrollController | null>(null)

/**
 * 每个消息区一个控制器。`key`（会话 id）变化时调 `open` 重新贴底；
 * 滚动区节点挂在 `boxRef` / `contentRef` 上，节点被卸载（切到子代理视图）时停掉观察。
 */
export function useChatScrollController(
  boxRef: RefObject<HTMLElement | null>,
  contentRef: RefObject<HTMLElement | null>,
  key: string | null,
): ChatScrollController {
  const [controller] = useState(createChatScrollController)
  useLayoutEffect(() => {
    const box = boxRef.current
    const content = contentRef.current
    if (box && content) controller.attach(box, content, key ?? '')
    else controller.detachDom()
  })
  useLayoutEffect(() => () => controller.destroy(), [controller])
  return controller
}

export function ChatScrollScope({
  controller,
  children,
}: {
  controller: ChatScrollController
  children: ReactNode
}) {
  return <ChatScrollContext.Provider value={controller}>{children}</ChatScrollContext.Provider>
}

/** 子树读控制器；不在消息区作用域内（独立滚动容器）时为 null。 */
export function useChatScroll(): ChatScrollController | null {
  return useContext(ChatScrollContext)
}
