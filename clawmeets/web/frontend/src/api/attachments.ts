// Shared helper for turning staged File objects into the base64 attachment
// payload the atomic user-message endpoint accepts.

export interface AttachedFilePayload {
  filename: string
  content_b64: string
}

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const result = reader.result as string
      // readAsDataURL yields "data:<mime>;base64,<payload>"; strip the prefix.
      const comma = result.indexOf(',')
      resolve(comma >= 0 ? result.slice(comma + 1) : result)
    }
    reader.onerror = () => reject(reader.error ?? new Error('file read failed'))
    reader.readAsDataURL(file)
  })
}

export async function filesToAttachments(
  files: File[]
): Promise<AttachedFilePayload[]> {
  return Promise.all(
    files.map(async (file) => ({
      filename: file.name,
      content_b64: await fileToBase64(file),
    }))
  )
}
