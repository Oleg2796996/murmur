function deriveFriendlyName(name, mime) {
    const n = name || "";
    if (!n) return "file";
    const hasRealExt = !n.endsWith(".bin") && n.includes(".");
    if (hasRealExt) return n;

    const extMap = {
        "application/pdf": "pdf",
        "text/plain": "txt",
        "application/msword": "doc",
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
        "application/vnd.ms-excel": "xls",
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
        "application/vnd.ms-powerpoint": "ppt",
        "application/vnd.openxmlformats-officedocument.presentationml.presentation": "pptx",
        "application/zip": "zip",
        "application/json": "json",
    };
    const ext = extMap[mime] || "bin";
    return n.replace(/\.bin$/, "") + "." + ext;
}
