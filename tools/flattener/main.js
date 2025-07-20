#!/usr/bin/env node

const { Command } = require('commander');
const fs = require('fs-extra');
const path = require('node:path');
const { glob } = require('glob');
const { minimatch } = require('minimatch');

/**
 * Recursively discover all files in a directory
 * @param {string} rootDir - The root directory to scan
 * @returns {Promise<string[]>} Array of file paths
 */
async function discoverFiles(rootDir) {
  try {
    const gitignorePath = path.join(rootDir, '.gitignore');
    const gitignorePatterns = await parseGitignore(gitignorePath);

    const combinedIgnores = [
    ...gitignorePatterns,
    '.git/**',
    'flattened-codebase.xml',
    'repomix-output.xml'
  ];

    // Use glob to recursively find all files, excluding common ignore patterns
    const files = await glob('**/*', {
      cwd: rootDir,
      nodir: true, // Only files, not directories
      dot: true,   // Include hidden files
      follow: false, // Don't follow symbolic links
      ignore: combinedIgnores
    });
    
    return files.map(file => path.resolve(rootDir, file));
  } catch (error) {
    console.error('Error discovering files:', error.message);
    return [];
  }
}

/**
 * Parse .gitignore file and return ignore patterns
 * @param {string} gitignorePath - Path to .gitignore file
 * @returns {Promise<string[]>} Array of ignore patterns
 */
async function parseGitignore(gitignorePath) {
  try {
    if (!await fs.pathExists(gitignorePath)) {
      return [];
    }
    
    const content = await fs.readFile(gitignorePath, 'utf8');
    return content
      .split('\n')
      .map(line => line.trim())
      .filter(line => line && !line.startsWith('#')) // Remove empty lines and comments
      .map(pattern => {
        // Convert gitignore patterns to glob patterns
        if (pattern.endsWith('/')) {
          return pattern + '**';
        }
        return pattern;
      });
  } catch (error) {
    console.error('Error parsing .gitignore:', error.message);
    return [];
  }
}

/**
 * Check if a file is binary using file command and heuristics
 * @param {string} filePath - Path to the file
 * @returns {Promise<boolean>} True if file is binary
 */
async function isBinaryFile(filePath) {
  try {
    // First check by file extension
    const binaryExtensions = [
      '.jpg', '.jpeg', '.png', '.gif', '.bmp', '.ico', '.svg',
      '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx',
      '.zip', '.tar', '.gz', '.rar', '.7z',
      '.exe', '.dll', '.so', '.dylib',
      '.mp3', '.mp4', '.avi', '.mov', '.wav',
      '.ttf', '.otf', '.woff', '.woff2',
      '.bin', '.dat', '.db', '.sqlite'
    ];
    
    const ext = path.extname(filePath).toLowerCase();
    if (binaryExtensions.includes(ext)) {
      return true;
    }
    
    // For files without clear extensions, try to read a small sample
    const stats = await fs.stat(filePath);
    if (stats.size === 0) {
      return false; // Empty files are considered text
    }
    
    // Read first 1024 bytes to check for null bytes
    const sampleSize = Math.min(1024, stats.size);
    const buffer = await fs.readFile(filePath, { encoding: null, flag: 'r' });
    const sample = buffer.slice(0, sampleSize);
    // If we find null bytes, it's likely binary
    return sample.includes(0);
  } catch (error) {
    console.warn(`Warning: Could not determine if file is binary: ${filePath} - ${error.message}`);
    return false; // Default to text if we can't determine
  }
}

/**
 * Read and aggregate content from text files
 * @param {string[]} files - Array of file paths
 * @param {string} rootDir - The root directory
 * @param {Object} spinner - Optional spinner instance for progress display
 * @returns {Promise<Object>} Object containing file contents and metadata
 */
async function aggregateFileContents(files, rootDir, spinner = null) {
  const results = {
    textFiles: [],
    binaryFiles: [],
    errors: [],
    totalFiles: files.length,
    processedFiles: 0
  };
  
  for (const filePath of files) {
    try {
      const relativePath = path.relative(rootDir, filePath);
      
      // Update progress indicator
      if (spinner) {
        spinner.text = `Processing file ${results.processedFiles + 1}/${results.totalFiles}: ${relativePath}`;
      }
      
      const isBinary = await isBinaryFile(filePath);
      
      if (isBinary) {
        results.binaryFiles.push({
          path: relativePath,
          absolutePath: filePath,
          size: (await fs.stat(filePath)).size
        });
      } else {
        // Read text file content
        const content = await fs.readFile(filePath, 'utf8');
        results.textFiles.push({
          path: relativePath,
          absolutePath: filePath,
          content: content,
          size: content.length,
          lines: content.split('\n').length
        });
      }
      
      results.processedFiles++;
    } catch (error) {
      const relativePath = path.relative(rootDir, filePath);
      const errorInfo = {
        path: relativePath,
        absolutePath: filePath,
        error: error.message
      };
      
      results.errors.push(errorInfo);
      
      // Log warning without interfering with spinner
      if (spinner) {
        spinner.warn(`Warning: Could not read file ${relativePath}: ${error.message}`);
      } else {
        console.warn(`Warning: Could not read file ${relativePath}: ${error.message}`);
      }
      
      results.processedFiles++;
    }
  }
  
  return results;
}

/**
 * Generate XML output with aggregated file contents
 * @param {Object} aggregatedContent - The aggregated content object
 * @param {string} projectRoot - The project root directory
 * @returns {string} XML content
 */
function generateXMLOutput(aggregatedContent) {
  const { textFiles } = aggregatedContent;
  
  let xml = `<?xml version="1.0" encoding="UTF-8"?>
`;
  xml += `<files>
`;
  
  // Add text files with content (only text files as per story requirements)
  for (const file of textFiles) {
    xml += `  <file path="${escapeXml(file.path)}">`;
    
    // Use CDATA for code content, handling CDATA end sequences properly
    if (file.content?.trim()) {
      const indentedContent = indentFileContent(file.content);
      if (file.content.includes(']]>')) {
        // If content contains ]]>, split it and wrap each part in CDATA
        xml += splitAndWrapCDATA(indentedContent);
      } else {
        xml += `<![CDATA[
${indentedContent}
    ]]>`;
      }
    } else if (file.content) {
      // Handle empty or whitespace-only content
      const indentedContent = indentFileContent(file.content);
      xml += `<![CDATA[
${indentedContent}
    ]]>`;
    }
    
    xml += `</file>
`;
  }
  
  xml += `</files>
`;
  return xml;
}

/**
 * Escape XML special characters for attributes
 * @param {string} str - String to escape
 * @returns {string} Escaped string
 */
function escapeXml(str) {
  if (typeof str !== 'string') {
    return String(str);
  }
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * Indent file content with 4 spaces for each line
 * @param {string} content - Content to indent
 * @returns {string} Indented content
 */
function indentFileContent(content) {
  if (typeof content !== 'string') {
    return String(content);
  }
  
  // Split content into lines and add 4 spaces of indentation to each line
  return content.split('\n').map(line => `    ${line}`).join('\n');
}

/**
 * Split content containing ]]> and wrap each part in CDATA
 * @param {string} content - Content to process
 * @returns {string} Content with properly wrapped CDATA sections
 */
function splitAndWrapCDATA(content) {
  if (typeof content !== 'string') {
    return String(content);
  }
  
  // Replace ]]> with ]]]]><![CDATA[> to escape it within CDATA
  const escapedContent = content.replace(/]]>/g, ']]]]><![CDATA[>');
  return `<![CDATA[
${escapedContent}
    ]]>`;
}

/**
 * Calculate statistics for the processed files
 * @param {Object} aggregatedContent - The aggregated content object
 * @param {string} xmlContent - The generated XML content
 * @returns {Object} Statistics object
 */
function calculateStatistics(aggregatedContent, xmlContent) {
  const { textFiles, binaryFiles, errors } = aggregatedContent;
  
  // Calculate total file size in bytes
  const totalTextSize = textFiles.reduce((sum, file) => sum + file.size, 0);
  const totalBinarySize = binaryFiles.reduce((sum, file) => sum + file.size, 0);
  const totalSize = totalTextSize + totalBinarySize;
  
  // Calculate total lines of code
  const totalLines = textFiles.reduce((sum, file) => sum + file.lines, 0);
  
  // Estimate token count (rough approximation: 1 token ≈ 4 characters)
  const estimatedTokens = Math.ceil(xmlContent.length / 4);
  
  // Format file size
  const formatSize = (bytes) => {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  };
  
  return {
    totalFiles: textFiles.length + binaryFiles.length,
    textFiles: textFiles.length,
    binaryFiles: binaryFiles.length,
    errorFiles: errors.length,
    totalSize: formatSize(totalSize),
    xmlSize: formatSize(xmlContent.length),
    totalLines,
    estimatedTokens: estimatedTokens.toLocaleString()
  };
}

/**
 * Filter files based on .gitignore patterns
 * @param {string[]} files - Array of file paths
 * @param {string} rootDir - The root directory
 * @returns {Promise<string[]>} Filtered array of file paths
 */
async function filterFiles(files, rootDir) {
  const gitignorePath = path.join(rootDir, '.gitignore');
  const ignorePatterns = await parseGitignore(gitignorePath);
  
  if (ignorePatterns.length === 0) {
    return files;
  }
  
  // Convert absolute paths to relative for pattern matching
  const relativeFiles = files.map(file => path.relative(rootDir, file));
  
  // Separate positive and negative patterns
  const positivePatterns = ignorePatterns.filter(p => !p.startsWith('!'));
  const negativePatterns = ignorePatterns.filter(p => p.startsWith('!')).map(p => p.slice(1));
  
  // Filter out files that match ignore patterns
  const filteredRelative = [];
  
  for (const file of relativeFiles) {
    let shouldIgnore = false;
    
    // First check positive patterns (ignore these files)
    for (const pattern of positivePatterns) {
      if (minimatch(file, pattern)) {
        shouldIgnore = true;
        break;
      }
    }
    
    // Then check negative patterns (don't ignore these files even if they match positive patterns)
    if (shouldIgnore) {
      for (const pattern of negativePatterns) {
        if (minimatch(file, pattern)) {
          shouldIgnore = false;
          break;
        }
      }
    }
    
    if (!shouldIgnore) {
      filteredRelative.push(file);
    }
  }
  
  // Convert back to absolute paths
  return filteredRelative.map(file => path.resolve(rootDir, file));
}

const program = new Command();

program
  .name('bmad-flatten')
  .description('BMad-Method codebase flattener tool')
  .version('1.0.0')
  .option('-o, --output <path>', 'Output file path', 'flattened-codebase.xml')
  .action(async (options) => {
    console.log(`Flattening codebase to: ${options.output}`);
    
    try {
      // Import ora dynamically
      const { default: ora } = await import('ora');
      
      // Start file discovery with spinner
      const discoverySpinner = ora('🔍 Discovering files...').start();
      const files = await discoverFiles(process.cwd());
      const filteredFiles = await filterFiles(files, process.cwd());
      discoverySpinner.succeed(`📁 Found ${filteredFiles.length} files to include`);
      
      // Process files with progress tracking
      console.log('Reading file contents');
      const processingSpinner = ora('📄 Processing files...').start();
      const aggregatedContent = await aggregateFileContents(filteredFiles, process.cwd(), processingSpinner);
      processingSpinner.succeed(`✅ Processed ${aggregatedContent.processedFiles}/${filteredFiles.length} files`);
      
      // Log processing results for test validation
      console.log(`Processed ${aggregatedContent.processedFiles}/${filteredFiles.length} files`);
      if (aggregatedContent.errors.length > 0) {
        console.log(`Errors: ${aggregatedContent.errors.length}`);
      }
      console.log(`Text files: ${aggregatedContent.textFiles.length}`);
      if (aggregatedContent.binaryFiles.length > 0) {
        console.log(`Binary files: ${aggregatedContent.binaryFiles.length}`);
      }
      
      // Generate XML output
      const xmlSpinner = ora('🔧 Generating XML output...').start();
      const xmlOutput = generateXMLOutput(aggregatedContent);
      await fs.writeFile(options.output, xmlOutput);
      xmlSpinner.succeed('📝 XML generation completed');
      
      // Calculate and display statistics
      const stats = calculateStatistics(aggregatedContent, xmlOutput);
      
      // Display completion summary
      console.log('\n📊 Completion Summary:');
      console.log(`✅ Successfully processed ${filteredFiles.length} files into ${options.output}`);
      console.log(`📁 Output file: ${path.resolve(options.output)}`);
      console.log(`📏 Total source size: ${stats.totalSize}`);
      console.log(`📄 Generated XML size: ${stats.xmlSize}`);
      console.log(`📝 Total lines of code: ${stats.totalLines.toLocaleString()}`);
      console.log(`🔢 Estimated tokens: ${stats.estimatedTokens}`);
      console.log(`📊 File breakdown: ${stats.textFiles} text, ${stats.binaryFiles} binary, ${stats.errorFiles} errors`);
      
    } catch (error) {
      console.error('❌ Critical error:', error.message);
      console.error('An unexpected error occurred.');
      process.exit(1);
    }
  });

if (require.main === module) {
  program.parse();
}

module.exports = program;