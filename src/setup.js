// 初回セットアップ画面。データ保存先フォルダを選ぶ/新規作成するまで
// メイン画面には進まない（保存先の既定フォールバックは設けない方針）。
const chooseBtn = document.getElementById("setup-choose");
const statusEl = document.getElementById("setup-status");

async function chooseFolder() {
  chooseBtn.disabled = true;
  statusEl.textContent = "";
  try {
    const result = await window.stockReviewApi.chooseDataDir();
    if (result?.canceled) {
      statusEl.textContent = "フォルダが選択されませんでした。開始するには保存先を選んでください。";
      return;
    }
    statusEl.textContent = `保存先を設定しました: ${result.dataDir}\nアプリを開始します…`;
    await window.stockReviewApi.enterMainApp();
  } catch (err) {
    statusEl.textContent = `設定に失敗しました: ${err.message}`;
  } finally {
    chooseBtn.disabled = false;
  }
}

chooseBtn?.addEventListener("click", chooseFolder);
