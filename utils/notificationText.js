// Server-side notification translation — title/body text for every
// sendNotificationToUser() call site, in the recipient's OWN language
// (userModel.language). This has to live on the backend: push notifications
// and Telegram messages are delivered OUTSIDE the app, so the frontend's
// i18next instance can never touch them — translation has to happen at
// SEND time, baked into what gets stored/pushed/messaged. An already-sent
// notification never retranslates if the user later changes their language
// preference — same as a generated PDF, this is expected, not a bug.
//
// Only the TEMPLATE wording is translated. User-typed content (task
// descriptions, batch titles, customer names, invoice numbers) is passed
// through as-is via params — translating someone's own free text would be
// wrong, not helpful.

const SUPPORTED = ['en', 'fa', 'ar'];
const pickLang = (lang) => (SUPPORTED.includes(lang) ? lang : 'en');

// Simple pluralizer for the three languages used here — English needs the
// 's', Farsi/Arabic (as rendered below) don't inflect the noun the way this
// app's short informal notification strings are phrased.
const plural = (lang, count, singular, pluralForm) => (lang === 'en' && count === 1 ? singular : pluralForm);

const TEMPLATES = {
  crmAssignmentUser: {
    en: ({ taskTitle, count }) => ({
      title: `New CRM assignment: ${taskTitle}`,
      body: `${count} ${plural('en', count, 'customer', 'customers')} assigned to you`,
    }),
    fa: ({ taskTitle, count }) => ({
      title: `تخصیص جدید CRM: ${taskTitle}`,
      body: `${count} مشتری به شما تخصیص داده شد`,
    }),
    ar: ({ taskTitle, count }) => ({
      title: `تكليف CRM جديد: ${taskTitle}`,
      body: `تم تعيين ${count} عميل لك`,
    }),
  },

  crmAssignmentGroup: {
    en: ({ taskTitle, count, groupName }) => ({
      title: `New group CRM assignment: ${taskTitle}`,
      body: `${count} ${plural('en', count, 'customer', 'customers')} assigned [${groupName || ''}]`,
    }),
    fa: ({ taskTitle, count, groupName }) => ({
      title: `تخصیص گروهی جدید CRM: ${taskTitle}`,
      body: `${count} مشتری تخصیص داده شد [${groupName || ''}]`,
    }),
    ar: ({ taskTitle, count, groupName }) => ({
      title: `تكليف CRM جماعي جديد: ${taskTitle}`,
      body: `تم تعيين ${count} عميل [${groupName || ''}]`,
    }),
  },

  dmRawContentUploaded: {
    en: ({ actorName, batchTitle }) => ({
      title: 'New raw content uploaded',
      body: `${actorName} uploaded ${batchTitle || 'a new batch'}`,
    }),
    fa: ({ actorName, batchTitle }) => ({
      title: 'محتوای خام جدید آپلود شد',
      body: `${actorName} «${batchTitle || 'دسته‌ای جدید'}» را آپلود کرد`,
    }),
    ar: ({ actorName, batchTitle }) => ({
      title: 'تم رفع محتوى خام جديد',
      body: `قام ${actorName} برفع "${batchTitle || 'دفعة جديدة'}"`,
    }),
  },

  tutorialCreated: {
    en: ({ actorName, tutorialTitle }) => ({
      title: 'New tutorial available',
      body: `${actorName} added "${tutorialTitle}"`,
    }),
    fa: ({ actorName, tutorialTitle }) => ({
      title: 'آموزش جدید در دسترس است',
      body: `${actorName} «${tutorialTitle}» را اضافه کرد`,
    }),
    ar: ({ actorName, tutorialTitle }) => ({
      title: 'شرح جديد متاح',
      body: `أضاف ${actorName} "${tutorialTitle}"`,
    }),
  },

  dmReadyToUploadOwner: {
    en: ({ actorName, batchTitle }) => ({
      title: 'Content is ready to upload',
      body: `${actorName} marked "${batchTitle || 'a batch'}" ready to upload`,
    }),
    fa: ({ actorName, batchTitle }) => ({
      title: 'محتوا آماده آپلود است',
      body: `${actorName} «${batchTitle || 'دسته‌ای'}» را آماده آپلود علامت‌گذاری کرد`,
    }),
    ar: ({ actorName, batchTitle }) => ({
      title: 'المحتوى جاهز للرفع',
      body: `قام ${actorName} بتمييز "${batchTitle || 'دفعة'}" كجاهز للرفع`,
    }),
  },

  dmReadyToUploadBroadcast: {
    en: ({ actorName, batchTitle }) => ({
      title: 'New content ready to upload',
      body: `${actorName} marked "${batchTitle || 'a batch'}" ready to upload`,
    }),
    fa: ({ actorName, batchTitle }) => ({
      title: 'محتوای جدید آماده آپلود',
      body: `${actorName} «${batchTitle || 'دسته‌ای'}» را آماده آپلود علامت‌گذاری کرد`,
    }),
    ar: ({ actorName, batchTitle }) => ({
      title: 'محتوى جديد جاهز للرفع',
      body: `قام ${actorName} بتمييز "${batchTitle || 'دفعة'}" كجاهز للرفع`,
    }),
  },

  dmReadyToUploadStandalone: {
    en: ({ actorName, batchTitle }) => ({
      title: 'New ready-to-upload content',
      body: `${actorName} uploaded ${batchTitle || 'new ready-to-upload content'}`,
    }),
    fa: ({ actorName, batchTitle }) => ({
      title: 'محتوای آماده آپلود جدید',
      body: `${actorName} «${batchTitle || 'محتوای آماده آپلود جدید'}» را آپلود کرد`,
    }),
    ar: ({ actorName, batchTitle }) => ({
      title: 'محتوى جاهز للرفع جديد',
      body: `قام ${actorName} برفع "${batchTitle || 'محتوى جاهز للرفع جديد'}"`,
    }),
  },

  // msgType: 'text'|'voice'|'file' — for 'text', textPreview carries the
  // actual (already length-capped) message body, passed through untranslated
  // since it's the sender's own words. For voice/file, there's no text to
  // show, so the body is a translated "Sent a voice message"/"Sent a file".
  dmChatMessage: {
    en: ({ msgType, textPreview }) => ({
      title: 'New message on your content',
      body: msgType === 'text' ? textPreview : (msgType === 'voice' ? 'Sent a voice message' : 'Sent a file'),
    }),
    fa: ({ msgType, textPreview }) => ({
      title: 'پیام جدید روی محتوای شما',
      body: msgType === 'text' ? textPreview : (msgType === 'voice' ? 'یک پیام صوتی ارسال کرد' : 'یک فایل ارسال کرد'),
    }),
    ar: ({ msgType, textPreview }) => ({
      title: 'رسالة جديدة على محتواك',
      body: msgType === 'text' ? textPreview : (msgType === 'voice' ? 'أرسل رسالة صوتية' : 'أرسل ملفًا'),
    }),
  },

  misInvoiceSent: {
    en: ({ label, docNumber, actorName }) => ({
      title: `${label} #${docNumber} was sent to you`,
      body: `${actorName} sent this ${label.toLowerCase()} to you`,
    }),
    fa: ({ label, docNumber, actorName }) => {
      const labelFa = label === 'Invoice' ? 'فاکتور' : 'پیش‌فاکتور';
      return { title: `${labelFa} شماره ${docNumber} برای شما ارسال شد`, body: `${actorName} این ${labelFa} را برای شما ارسال کرد` };
    },
    ar: ({ label, docNumber, actorName }) => {
      const labelAr = label === 'Invoice' ? 'الفاتورة' : 'عرض السعر';
      return { title: `تم إرسال ${labelAr} رقم ${docNumber} إليك`, body: `أرسل لك ${actorName} ${labelAr}` };
    },
  },

  taskAssignedUser: {
    en: ({ title, description }) => ({ title: `New task: ${title}`, body: description }),
    fa: ({ title, description }) => ({ title: `وظیفه جدید: ${title}`, body: description }),
    ar: ({ title, description }) => ({ title: `مهمة جديدة: ${title}`, body: description }),
  },

  taskAssignedGroup: {
    en: ({ title, description, groupName }) => ({
      title: `New group task: ${title}`,
      body: `${description}${groupName ? ` [${groupName}]` : ''}`,
    }),
    fa: ({ title, description, groupName }) => ({
      title: `وظیفه گروهی جدید: ${title}`,
      body: `${description}${groupName ? ` [${groupName}]` : ''}`,
    }),
    ar: ({ title, description, groupName }) => ({
      title: `مهمة جماعية جديدة: ${title}`,
      body: `${description}${groupName ? ` [${groupName}]` : ''}`,
    }),
  },

  taskClaimed: {
    en: ({ claimedByName, taskTitle }) => ({ title: `Task claimed: ${taskTitle}`, body: `${claimedByName} claimed your task` }),
    fa: ({ claimedByName, taskTitle }) => ({ title: `وظیفه ادعا شد: ${taskTitle}`, body: `${claimedByName} وظیفه شما را ادعا کرد` }),
    ar: ({ claimedByName, taskTitle }) => ({ title: `تم استلام المهمة: ${taskTitle}`, body: `استلم ${claimedByName} مهمتك` }),
  },

  taskDone: {
    en: ({ byName, taskTitle }) => ({ title: `Task done: ${taskTitle}`, body: `${byName} marked your task as done` }),
    fa: ({ byName, taskTitle }) => ({ title: `وظیفه انجام شد: ${taskTitle}`, body: `${byName} وظیفه شما را انجام‌شده علامت‌گذاری کرد` }),
    ar: ({ byName, taskTitle }) => ({ title: `تمت المهمة: ${taskTitle}`, body: `قام ${byName} بتمييز مهمتك كمكتملة` }),
  },
};

// Renders {title, body} for a template key in the given language, falling
// back to English if the key or language variant is missing (never blocks a
// send over a translation gap). Returns null only if the key doesn't exist
// at all — callers should keep their own literal fallback for that case.
function renderNotificationText(key, lang, params = {}) {
  const dict = TEMPLATES[key];
  if (!dict) return null;
  const variant = dict[pickLang(lang)] || dict.en;
  return variant(params);
}

module.exports = { renderNotificationText, SUPPORTED_NOTIFICATION_LANGUAGES: SUPPORTED };
