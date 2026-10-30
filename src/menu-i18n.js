/* CUCI — native application-menu strings (loaded by lib/i18n-main.js). */
(function () {
  const C = window.CUCI;
  if (!C || !C.i18n) return;

  C.i18n.extend({
    en: {
      menuFile: 'File', menuEdit: 'Edit', menuView: 'View', menuPanels: 'Panels', menuHelp: 'Help',
      menuExit: 'Exit', menuPin: 'Pin / hide', menuDetach: 'Detach / dock', menuAbout: 'About CUCI',
      menuSetIn: 'Set In', menuSetOut: 'Set Out', menuDeleteSel: 'Delete selection', menuClearMarks: 'Clear In/Out',
      menuClearDeletes: 'Clear all deletions', menuZoomIn: 'Zoom in', menuZoomOut: 'Zoom out', menuFullScreen: 'Full screen',
    },
    ms: {
      menuFile: 'Fail', menuEdit: 'Sunting', menuView: 'Paparan', menuPanels: 'Panel', menuHelp: 'Bantuan',
      menuExit: 'Keluar', menuPin: 'Pin / sembunyi', menuDetach: 'Asingkan / dok', menuAbout: 'Tentang CUCI',
      menuSetIn: 'Tetapkan Masuk', menuSetOut: 'Tetapkan Keluar', menuDeleteSel: 'Padam pilihan', menuClearMarks: 'Kosongkan Masuk/Keluar',
      menuClearDeletes: 'Buang semua pemadaman', menuZoomIn: 'Zum masuk', menuZoomOut: 'Zum keluar', menuFullScreen: 'Skrin penuh',
    },
    id: {
      menuFile: 'Berkas', menuEdit: 'Edit', menuView: 'Tampilan', menuPanels: 'Panel', menuHelp: 'Bantuan',
      menuExit: 'Keluar', menuPin: 'Semat / sembunyikan', menuDetach: 'Lepas / dok', menuAbout: 'Tentang CUCI',
      menuSetIn: 'Set Masuk', menuSetOut: 'Set Keluar', menuDeleteSel: 'Hapus pilihan', menuClearMarks: 'Hapus Masuk/Keluar',
      menuClearDeletes: 'Kosongkan semua penghapusan', menuZoomIn: 'Perbesar', menuZoomOut: 'Perkecil', menuFullScreen: 'Layar penuh',
    },
    zh: {
      menuFile: '文件', menuEdit: '编辑', menuView: '视图', menuPanels: '面板', menuHelp: '帮助',
      menuExit: '退出', menuPin: '固定 / 隐藏', menuDetach: '分离 / 停靠', menuAbout: '关于 CUCI',
      menuSetIn: '设置入点', menuSetOut: '设置出点', menuDeleteSel: '删除所选', menuClearMarks: '清除入/出点',
      menuClearDeletes: '清除所有删除', menuZoomIn: '放大', menuZoomOut: '缩小', menuFullScreen: '全屏',
    },
    es: {
      menuFile: 'Archivo', menuEdit: 'Edición', menuView: 'Ver', menuPanels: 'Paneles', menuHelp: 'Ayuda',
      menuExit: 'Salir', menuPin: 'Fijar / ocultar', menuDetach: 'Separar / acoplar', menuAbout: 'Acerca de CUCI',
      menuSetIn: 'Marcar entrada', menuSetOut: 'Marcar salida', menuDeleteSel: 'Eliminar selección', menuClearMarks: 'Borrar entrada/salida',
      menuClearDeletes: 'Eliminar todos los eliminaciones', menuZoomIn: 'Acercar', menuZoomOut: 'Alejar', menuFullScreen: 'Pantalla completa',
    },
    fr: {
      menuFile: 'Fichier', menuEdit: 'Édition', menuView: 'Affichage', menuPanels: 'Panneaux', menuHelp: 'Aide',
      menuExit: 'Quitter', menuPin: 'Épingler / masquer', menuDetach: 'Détacher / ancrer', menuAbout: 'À propos de CUCI',
      menuSetIn: 'Poser l’entrée', menuSetOut: 'Poser la sortie', menuDeleteSel: 'Suppressionr la sélection', menuClearMarks: 'Effacer entrée/sortie',
      menuClearDeletes: 'Supprimer toutes les suppressions', menuZoomIn: 'Zoom avant', menuZoomOut: 'Zoom arrière', menuFullScreen: 'Plein écran',
    },
    de: {
      menuFile: 'Datei', menuEdit: 'Bearbeiten', menuView: 'Ansicht', menuPanels: 'Panels', menuHelp: 'Hilfe',
      menuExit: 'Beenden', menuPin: 'Anpinnen / ausblenden', menuDetach: 'Lösen / andocken', menuAbout: 'Über CUCI',
      menuSetIn: 'In-Punkt setzen', menuSetOut: 'Out-Punkt setzen', menuDeleteSel: 'Auswahl löschen', menuClearMarks: 'In/Out löschen',
      menuClearDeletes: 'Alle Löschungen löschen', menuZoomIn: 'Vergrößern', menuZoomOut: 'Verkleinern', menuFullScreen: 'Vollbild',
    },
    pt: {
      menuFile: 'Arquivo', menuEdit: 'Editar', menuView: 'Exibir', menuPanels: 'Painéis', menuHelp: 'Ajuda',
      menuExit: 'Sair', menuPin: 'Fixar / ocultar', menuDetach: 'Destacar / encaixar', menuAbout: 'Sobre o CUCI',
      menuSetIn: 'Marcar entrada', menuSetOut: 'Marcar saída', menuDeleteSel: 'Excluir seleção', menuClearMarks: 'Limpar entrada/saída',
      menuClearDeletes: 'Remover todos os exclusões', menuZoomIn: 'Ampliar', menuZoomOut: 'Reduzir', menuFullScreen: 'Tela cheia',
    },
    ru: {
      menuFile: 'Файл', menuEdit: 'Правка', menuView: 'Вид', menuPanels: 'Панели', menuHelp: 'Справка',
      menuExit: 'Выход', menuPin: 'Закрепить / скрыть', menuDetach: 'Отсоединить / пристыковать', menuAbout: 'О CUCI',
      menuSetIn: 'Задать вход', menuSetOut: 'Задать выход', menuDeleteSel: 'Удалить выделение', menuClearMarks: 'Очистить вход/выход',
      menuClearDeletes: 'Удалить все удаления', menuZoomIn: 'Увеличить', menuZoomOut: 'Уменьшить', menuFullScreen: 'Полный экран',
    },
    ja: {
      menuFile: 'ファイル', menuEdit: '編集', menuView: '表示', menuPanels: 'パネル', menuHelp: 'ヘルプ',
      menuExit: '終了', menuPin: 'ピン / 非表示', menuDetach: '分離 / ドッキング', menuAbout: 'CUCI について',
      menuSetIn: 'イン点を設定', menuSetOut: 'アウト点を設定', menuDeleteSel: '選択範囲を削除', menuClearMarks: 'イン/アウトをクリア',
      menuClearDeletes: 'すべての削除を削除', menuZoomIn: '拡大', menuZoomOut: '縮小', menuFullScreen: '全画面',
    },
    ko: {
      menuFile: '파일', menuEdit: '편집', menuView: '보기', menuPanels: '패널', menuHelp: '도움말',
      menuExit: '종료', menuPin: '고정 / 숨기기', menuDetach: '분리 / 도킹', menuAbout: 'CUCI 정보',
      menuSetIn: '인점 설정', menuSetOut: '아웃점 설정', menuDeleteSel: '선택 구간 삭제', menuClearMarks: '인/아웃 지우기',
      menuClearDeletes: '모든 삭제 지우기', menuZoomIn: '확대', menuZoomOut: '축소', menuFullScreen: '전체 화면',
    },
    ar: {
      menuFile: 'ملف', menuEdit: 'تحرير', menuView: 'عرض', menuPanels: 'اللوحات', menuHelp: 'مساعدة',
      menuExit: 'خروج', menuPin: 'تثبيت / إخفاء', menuDetach: 'فصل / إرساء', menuAbout: 'حول CUCI',
      menuSetIn: 'تعيين البداية', menuSetOut: 'تعيين النهاية', menuDeleteSel: 'احذف المحدد', menuClearMarks: 'مسح البداية/النهاية',
      menuClearDeletes: 'مسح كل المحذوفات', menuZoomIn: 'تكبير', menuZoomOut: 'تصغير', menuFullScreen: 'ملء الشاشة',
    },
    hi: {
      menuFile: 'फ़ाइल', menuEdit: 'संपादन', menuView: 'दृश्य', menuPanels: 'पैनल', menuHelp: 'सहायता',
      menuExit: 'बाहर निकलें', menuPin: 'पिन / छिपाएँ', menuDetach: 'अलग / डॉक करें', menuAbout: 'CUCI के बारे में',
      menuSetIn: 'इन सेट करें', menuSetOut: 'आउट सेट करें', menuDeleteSel: 'चयन हटाएँ', menuClearMarks: 'इन/आउट साफ़ करें',
      menuClearDeletes: 'सभी हटाए गए साफ़ करें', menuZoomIn: 'ज़ूम इन', menuZoomOut: 'ज़ूम आउट', menuFullScreen: 'पूरा स्क्रीन',
    },
    tr: {
      menuFile: 'Dosya', menuEdit: 'Düzen', menuView: 'Görünüm', menuPanels: 'Paneller', menuHelp: 'Yardım',
      menuExit: 'Çıkış', menuPin: 'Sabitle / gizle', menuDetach: 'Ayır / yerleştir', menuAbout: 'CUCI hakkında',
      menuSetIn: 'Giriş ayarla', menuSetOut: 'Çıkış ayarla', menuDeleteSel: 'Seçimi kes', menuClearMarks: 'Giriş/çıkışı temizle',
      menuClearDeletes: 'Tüm silmeleri temizle', menuZoomIn: 'Yakınlaştır', menuZoomOut: 'Uzaklaştır', menuFullScreen: 'Tam ekran',
    },
  });
})();
