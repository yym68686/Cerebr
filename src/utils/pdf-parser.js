// Access the global pdfjsLib object provided by the script tag in index.html
const pdfjsLib = window.pdfjsLib;

// Correctly set the worker path using the chrome runtime API.
pdfjsLib.GlobalWorkerOptions.workerSrc = chrome.runtime.getURL('lib/pdf.worker.js');

export async function estimateGPTTokens(text) {
  try {
    const estimatedTokens = Math.ceil(text.length / 4.25625);
    return estimatedTokens;
  } catch (error) {
    console.error('Error estimating GPT tokens:', error);
    return 0;
  }
}

async function getPDFArrayBuffer(url) {
    try {
        const response = await fetch(url);
        if (!response.ok) {
            throw new Error(`Failed to download PDF file: ${response.statusText}`);
        }
        return response.arrayBuffer();
    } catch (error) {
        console.error(`Fetch error for ${url}:`, error);
        throw error;
    }
}

export async function extractTextFromPDF(url, updatePlaceholder) {
  try {
    if (updatePlaceholder) updatePlaceholder('Downloading PDF file...');
    const arrayBuffer = await getPDFArrayBuffer(url);

    if (updatePlaceholder) updatePlaceholder('Parsing PDF file...');
    const loadingTask = pdfjsLib.getDocument({data: arrayBuffer});
    const pdf = await loadingTask.promise;

    let fullText = '';
    for (let i = 1; i <= pdf.numPages; i++) {
      if (updatePlaceholder) updatePlaceholder(`Extracting text (${i}/${pdf.numPages})...`);
      const page = await pdf.getPage(i);
      const textContent = await page.getTextContent();
      const pageText = textContent.items.map(item => item.str).join(' ');
      fullText += pageText + '\n';
    }

    const gptTokenCount = await estimateGPTTokens(fullText);
    console.log('PDF text extraction complete. Total length:', fullText.length, 'Estimated GPT tokens:', gptTokenCount);
    if (updatePlaceholder) updatePlaceholder(`PDF processing complete (approx. ${gptTokenCount} tokens)`, 2000);
    return fullText;
  } catch (error) {
    console.error('An error occurred during PDF processing:', error);
    if (updatePlaceholder) updatePlaceholder('Failed to process PDF.', 2000);
    return null;
  }
}