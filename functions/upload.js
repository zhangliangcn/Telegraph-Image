import { errorHandling, telemetryData } from "./utils/middleware";

export async function onRequestPost(context) {
    const { request, env } = context;
    // console.log("Current ENV keys:", Object.keys(env));


    if (!env.TG_Chat_ID || !env.TG_Bot_Token) {
        return new Response(
            JSON.stringify({ error: 'Missing Telegram Configuration: TG_Chat_ID or TG_Bot_Token is not set.' }),
            {
                status: 500,
                headers: { 'Content-Type': 'application/json' }
            }
        );
    }

    try {
        const clonedRequest = request.clone();
        const formData = await clonedRequest.formData();

        await errorHandling(context);
        telemetryData(context);

        const uploadFile = formData.get('file');
        if (!uploadFile) {
            throw new Error('No file uploaded');
        }

        // 小程序上传时可能没有 name 属性，或者默认为 "file"
        let fileName = uploadFile.name || `wx_upload_${Date.now()}`;
        if (fileName === "file") {
            fileName = `wx_upload_${Date.now()}`;
        }

        const fileExtension = fileName.includes('.') ? fileName.split('.').pop().toLowerCase() : 'jpg';

        const telegramFormData = new FormData();
        telegramFormData.append("chat_id", env.TG_Chat_ID);

        // 📦 [标记: 资源处理] 根据文件类型准备上传数据
        // 根据文件类型选择合适的上传方式
        let apiEndpoint;
        if (uploadFile.type.startsWith('image/')) {
            telegramFormData.append("photo", uploadFile);
            apiEndpoint = 'sendPhoto';
        } else if (uploadFile.type.startsWith('audio/')) {
            telegramFormData.append("audio", uploadFile);
            apiEndpoint = 'sendAudio';
        } else if (uploadFile.type.startsWith('video/')) {
            telegramFormData.append("video", uploadFile);
            apiEndpoint = 'sendVideo';
        } else {
            telegramFormData.append("document", uploadFile);
            apiEndpoint = 'sendDocument';
        }

        // 🚀 [标记: 资源上传] 调用 Telegram API 上传文件
        const result = await sendToTelegram(telegramFormData, apiEndpoint, env);

        if (!result.success) {
            throw new Error(result.error);
        }

        const fileId = getFileId(result.data);

        if (!fileId) {
            throw new Error('Failed to get file ID');
        }

        // 将文件信息保存到 KV 存储
        if (env.img_url) {
            await env.img_url.put(`${fileId}.${fileExtension}`, "", {
                metadata: {
                    TimeStamp: Date.now(),
                    ListType: "None",
                    Label: "None",
                    liked: false,
                    fileName: fileName,
                    fileSize: uploadFile.size,
                }
            });
        }

        // 💾 [标记: 外部 API 登记] 将图片信息同步到外部数据库
        let apiLog = { status: 'skipped', details: null, env_keys: Object.keys(env) };
        const apiBaseUrl = env.API_BASE_URL || "https://azhangliang.iepose.cn";

        if (apiBaseUrl) {
            try {
                const apiData = {
                    img_name: fileName || "Untitled",
                    img_url: `/file/${fileId}.${fileExtension}`,
                    img_desc: "From Telegraph-Image (MiniProgram)",
                    img_type: fileExtension || "unknown",
                    img_size: uploadFile.size || 0
                };

                const apiResponse = await fetch(`${apiBaseUrl}/api/imgresource`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(apiData)
                });

                const apiResult = await apiResponse.json();
                apiLog = {
                    ...apiLog,
                    status: apiResponse.ok ? 'success' : 'failed',
                    statusCode: apiResponse.status,
                    response: apiResult
                };
            } catch (apiError) {
                // console.error('External API registration failed:', apiError);
                apiLog = {
                    ...apiLog,
                    status: 'error',
                    message: apiError.message
                };
            }
        }

        // ✅ [标记: 成功返回值] 上传成功后的响应，返回图片的相对路径 1ad
        // 调试信息已加入返回值，您可以通过浏览器 Network 面板查看 Response
        return new Response(
            JSON.stringify([{
                'src': `/file/${fileId}.${fileExtension}`,
                'api_log': apiLog

            }]),
            {
                status: 200,
                headers: { 'Content-Type': 'application/json' }
            }
        );
    } catch (error) {
        // console.error('Upload error:', error);
        return new Response(
            JSON.stringify({ error: error.message }),
            {
                status: 500,
                headers: { 'Content-Type': 'application/json' }
            }
        );
    }
}

function getFileId(response) {
    if (!response.ok || !response.result) return null;

    const result = response.result;
    if (result.photo) {
        return result.photo.reduce((prev, current) =>
            (prev.file_size > current.file_size) ? prev : current
        ).file_id;
    }
    if (result.document) return result.document.file_id;
    if (result.video) return result.video.file_id;
    if (result.audio) return result.audio.file_id;

    return null;
}

async function sendToTelegram(formData, apiEndpoint, env, retryCount = 0) {
    const MAX_RETRIES = 2;
    const apiUrl = `https://api.telegram.org/bot${env.TG_Bot_Token}/${apiEndpoint}`;

    try {
        const response = await fetch(apiUrl, { method: "POST", body: formData });
        const responseData = await response.json();

        if (response.ok) {
            return { success: true, data: responseData };
        }

        // 图片上传失败时转为文档方式重试
        if (retryCount < MAX_RETRIES && apiEndpoint === 'sendPhoto') {
            // console.log('Retrying image as document...');
            const newFormData = new FormData();
            newFormData.append('chat_id', formData.get('chat_id'));
            newFormData.append('document', formData.get('photo'));
            return await sendToTelegram(newFormData, 'sendDocument', env, retryCount + 1);
        }

        return {
            success: false,
            error: responseData.description || 'Upload to Telegram failed'
        };
    } catch (error) {
        // console.error('Network error:', error);
        if (retryCount < MAX_RETRIES) {
            await new Promise(resolve => setTimeout(resolve, 1000 * (retryCount + 1)));
            return await sendToTelegram(formData, apiEndpoint, env, retryCount + 1);
        }
        return { success: false, error: 'Network error occurred' };
    }
}