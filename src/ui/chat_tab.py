"""AI assistant chat tab UI. (Phase 5)"""
import gradio as gr

from src.ui.components import llm_status_badge


def build_chat_tab(yahoo_client, llm_client) -> None:
    """Build the chat assistant tab. Fully implemented in Phase 5."""
    gr.Markdown("## 💬 AI アシスタント")

    status = llm_status_badge(llm_client.is_available())
    gr.Markdown(status)

    gr.Markdown(
        "銘柄の分析・ポートフォリオ相談・比較分析などを自然言語で行えます。\n\n"
        "> *Phase 5 で実装予定です。*\n\n"
        "**実装予定の機能例:**\n"
        "- 「トヨタの最近の業績はどう？」\n"
        "- 「この銘柄がランクインした理由は？」\n"
        "- 「今のポートフォリオのリスクは？」\n"
        "- 「トヨタとホンダを比較して」"
    )

    chatbot = gr.Chatbot(label="会話履歴", height=400)
    with gr.Row():
        msg_input = gr.Textbox(
            label="質問を入力",
            placeholder="例: トヨタの投資魅力を教えて",
            scale=5,
        )
        send_btn = gr.Button("送信", variant="primary", scale=1)

    def respond(message: str, history: list):
        reply = "Phase 5 で実装されます。現在は利用できません。"
        history.append((message, reply))
        return "", history

    send_btn.click(respond, inputs=[msg_input, chatbot], outputs=[msg_input, chatbot])
    msg_input.submit(respond, inputs=[msg_input, chatbot], outputs=[msg_input, chatbot])
