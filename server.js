const chromium = require('chrome-aws-lambda');
const puppeteer = require('puppeteer-core');
const fs = require('fs');
const express = require('express');
const path = require('path');
const bodyParser = require('body-parser');
const xlsx = require('xlsx'); // Thêm thư viện XLSX

// Xác định môi trường và thư mục đầu ra
const isProduction = process.env.NODE_ENV === 'production';
const OUTPUT_DIR = isProduction ? '/tmp' : path.join(__dirname, 'tmp');

// Đảm bảo thư mục tmp tồn tại
if (!fs.existsSync(OUTPUT_DIR)) {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
}

// Cấu hình mặc định
let CONFIG = {
  // URL của trang web bạn muốn scrape
  targetUrl: 'https://www.example.com/business-directory',
  
  // Số trang bạn muốn scrape
  pagesToScrape: 5,
  
  // Thời gian chờ cho mỗi trang (ms)
  pageTimeout: 30000,
  
  // File output với đường dẫn được điều chỉnh
  outputFile: path.join(OUTPUT_DIR, 'business_data.json'),
  excelFile: path.join(OUTPUT_DIR, 'business_data.xlsx'),
  csvFile: path.join(OUTPUT_DIR, 'business_data.csv'),
  
  // Cấu hình CSS selector (cần điều chỉnh cho phù hợp với trang web mục tiêu)
  selectors: {
    businessList: '.business-list .business-item', // Danh sách các doanh nghiệp
    businessName: '.business-name',                // Tên doanh nghiệp
    businessPhone: '.business-phone',              // Số điện thoại
    businessWebsite: '.business-website a',        // Website
    nextPageButton: '.pagination .next-page'       // Nút chuyển trang
  }
};

// Biến lưu trạng thái scraping
let isScraping = false;
let scrapingProgress = { current: 0, total: 0, businesses: 0 };
let scrapingResults = [];

// Hàm chính (sửa để trả kết quả trực tiếp)
async function main(config = CONFIG) {
  if (isScraping) {
    return { success: false, message: 'Đang có quá trình scrape đang chạy' };
  }
  
  isScraping = true;
  scrapingProgress = { current: 0, total: config.pagesToScrape, businesses: 0 };
  scrapingResults = [];
  
  try {
    // Gán lại cấu hình từ tham số
    CONFIG = { ...CONFIG, ...config };
    
    // Đảm bảo paths luôn đúng
    CONFIG.outputFile = path.join(OUTPUT_DIR, path.basename(CONFIG.outputFile));
    CONFIG.excelFile = path.join(OUTPUT_DIR, path.basename(CONFIG.excelFile));
    CONFIG.csvFile = path.join(OUTPUT_DIR, path.basename(CONFIG.csvFile || 'business_data.csv'));
    
    console.log("Cấu hình cuối cùng sử dụng:", CONFIG);
    
    // Bắt đầu scraping
    const data = await scrapeBusinessInfo();
    
    if (data && data.length > 0) {
      // Xuất dữ liệu ra file
      exportToExcel(data, CONFIG.excelFile);
      exportToCSV(data, CONFIG.csvFile);
      fs.writeFileSync(CONFIG.outputFile, JSON.stringify(data, null, 2));
      
      // Lọc và lưu kết quả dạng đơn giản
      const simplifiedData = data.map(item => ({
        name: item.name || '',
        phone: item.phone || '',
        email: item.email || '',
        hotline: item.hotline || '',
        zalo: item.zalo || ''
      }));
      scrapingResults = simplifiedData;
      
      return { 
        success: true, 
        message: `Đã scrape thành công ${data.length} mục`,
        data: simplifiedData
      };
    } else {
      return { 
        success: false, 
        message: 'Không tìm thấy dữ liệu nào' 
      };
    }
  } catch (error) {
    console.error('Lỗi trong quá trình chạy:', error);
    return { success: false, message: `Lỗi: ${error.message}` };
  } finally {
    isScraping = false;
  }
}

// Hàm trích xuất thông tin doanh nghiệp
async function extractBusinessInfo(page) {
  try {
    console.log('Bắt đầu trích xuất thông tin...');
    
    // Lấy tiêu đề trang
    const pageTitle = await page.title();
    console.log('Tiêu đề trang:', pageTitle);
    
    // Lấy tên công ty từ các phần tử quan trọng
    const businessNames = await page.evaluate(() => {
      // Các phần tử thường chứa tên công ty
      const nameElements = [
        ...Array.from(document.querySelectorAll('h1')),
        ...Array.from(document.querySelectorAll('.company-name')),
        ...Array.from(document.querySelectorAll('.organization-name')),
        ...Array.from(document.querySelectorAll('.brand')),
        ...Array.from(document.querySelectorAll('.logo-text')),
        ...Array.from(document.querySelectorAll('title')),
        ...Array.from(document.querySelectorAll('#company-name')),
        ...Array.from(document.querySelectorAll('[itemtype*="Organization"]')),
        ...Array.from(document.querySelectorAll('.about-company h2')),
        ...Array.from(document.querySelectorAll('.contact-info h2')),
        ...Array.from(document.querySelectorAll('.footer-logo-text')),
        ...Array.from(document.querySelectorAll('.header-company-name'))
      ];
      
      return nameElements.map(el => el.textContent.trim())
        .filter(name => name.length > 2 && name.length < 100) // Lọc tên quá ngắn hoặc quá dài
        .filter((name, index, self) => self.indexOf(name) === index); // Loại bỏ trùng lặp
    });
    
    // Lấy các số điện thoại và hotline có thể có trên trang
    const phoneInfo = await page.evaluate(() => {
      // Regex cơ bản để tìm số điện thoại
      const phoneRegex = /(?:\+?(?:[\d\s\(\)\-\.]{7,}))(?:\s*(?:x|ext|extension)\s*\.?\s*(?:\d+))?/g;
      
      // Tìm trong văn bản của trang
      const text = document.body.innerText;
      const textMatches = text.match(phoneRegex) || [];
      
      // Tìm trong các phần tử thường chứa số điện thoại
      const phoneElements = [
        ...Array.from(document.querySelectorAll('.phone')),
        ...Array.from(document.querySelectorAll('.tel')),
        ...Array.from(document.querySelectorAll('[itemprop="telephone"]')),
        ...Array.from(document.querySelectorAll('.contact-phone')),
        ...Array.from(document.querySelectorAll('.contact-info')),
        ...Array.from(document.querySelectorAll('a[href^="tel:"]')),
        ...Array.from(document.querySelectorAll('.phone-number')),
        ...Array.from(document.querySelectorAll('.footer-contact'))
      ];
      
      const elementPhones = [];
      
      phoneElements.forEach(el => {
        // Lấy từ href nếu là link điện thoại
        if (el.tagName === 'A' && el.getAttribute('href') && el.getAttribute('href').startsWith('tel:')) {
          const tel = el.getAttribute('href').replace('tel:', '');
          if (tel && tel.length > 6) elementPhones.push(tel);
        }
        
        // Lấy từ nội dung văn bản
        const elText = el.textContent.trim();
        const elMatches = elText.match(phoneRegex);
        if (elMatches) elementPhones.push(...elMatches);
      });
      
      // Tìm kiếm cụ thể từ khóa hotline và Zalo
      const hotlineElements = [
        ...Array.from(document.querySelectorAll('*:not(script):not(style)')).filter(el => {
          const text = el.textContent.toLowerCase();
          return text.includes('hotline') || text.includes('zalo');
        })
      ];
      
      const hotlines = [];
      const zaloNumbers = [];
      
      hotlineElements.forEach(el => {
        const text = el.textContent.trim();
        // Tìm số điện thoại trong phần tử có chứa từ khóa hotline/zalo
        const matches = text.match(phoneRegex);
        
        if (matches) {
          if (text.toLowerCase().includes('hotline')) {
            hotlines.push(...matches);
          }
          if (text.toLowerCase().includes('zalo')) {
            zaloNumbers.push(...matches);
          }
        }
      });
      
      // Kết hợp và loại bỏ trùng lặp
      const allPhones = [...new Set([...textMatches, ...elementPhones])]
        .map(phone => phone.trim())
        .filter(phone => phone.replace(/[^\d]/g, '').length >= 7);
      
      return {
        phones: allPhones,
        hotlines: [...new Set(hotlines)],
        zaloNumbers: [...new Set(zaloNumbers)]
      };
    });
    
    // Lấy địa chỉ email
    const emails = await page.evaluate(() => {
      // Regex để tìm email
      const emailRegex = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
      
      // Phương pháp 1: Tìm trong văn bản
      const bodyText = document.body.innerText;
      const textMatches = bodyText.match(emailRegex) || [];
      
      // Phương pháp 2: Tìm trong các liên kết mailto
      const emailLinks = Array.from(document.querySelectorAll('a[href^="mailto:"]'));
      const mailtoEmails = emailLinks.map(link => {
        const href = link.getAttribute('href');
        return href.replace('mailto:', '').split('?')[0];
      });
      
      // Phương pháp 3: Tìm trong các phần tử liên quan đến email
      const emailElements = [
        ...Array.from(document.querySelectorAll('.email')),
        ...Array.from(document.querySelectorAll('.mail')),
        ...Array.from(document.querySelectorAll('#email')),
        ...Array.from(document.querySelectorAll('[data-email]')),
        ...Array.from(document.querySelectorAll('[itemprop="email"]')),
        ...Array.from(document.querySelectorAll('.contact-email')),
        ...Array.from(document.querySelectorAll('.contact-mail')),
        ...Array.from(document.querySelectorAll('.contact-info')),
        ...Array.from(document.querySelectorAll('.footer-email'))
      ];
      
      const elementEmails = [];
      emailElements.forEach(el => {
        const text = el.textContent;
        const matches = text.match(emailRegex);
        if (matches) elementEmails.push(...matches);
        
        // Kiểm tra thuộc tính data-email
        const dataEmail = el.getAttribute('data-email');
        if (dataEmail && emailRegex.test(dataEmail)) {
          elementEmails.push(dataEmail);
        }
      });
      
      // Kết hợp và loại bỏ trùng lặp
      return [...new Set([...textMatches, ...mailtoEmails, ...elementEmails])]
        .map(email => email.trim().toLowerCase());
    });
    
    // Lấy tên doanh nghiệp từ meta tags
    const metaBusinessName = await page.evaluate(() => {
      const ogSiteName = document.querySelector('meta[property="og:site_name"]');
      const metaName = document.querySelector('meta[name="author"]');
      const metaPublisher = document.querySelector('meta[name="publisher"]');
      
      if (ogSiteName) return ogSiteName.getAttribute('content');
      if (metaName) return metaName.getAttribute('content');
      if (metaPublisher) return metaPublisher.getAttribute('content');
      
      return null;
    });
    
    // Biến lưu kết quả
    const results = [];
    
    // Case 1: Kết hợp thông tin từ trang tổng thể
    if (businessNames.length > 0 || metaBusinessName) {
      // Ưu tiên tên từ meta, sau đó là h1 đầu tiên, sau đó là title
      const bestName = metaBusinessName || businessNames[0] || pageTitle;
      
      const mainEntry = {
        name: bestName,
        phone: phoneInfo.phones.length > 0 ? phoneInfo.phones[0] : 'N/A',
        email: emails.length > 0 ? emails[0] : 'N/A',
        hotline: phoneInfo.hotlines.length > 0 ? phoneInfo.hotlines[0] : 'N/A',
        zalo: phoneInfo.zaloNumbers.length > 0 ? phoneInfo.zaloNumbers[0] : 'N/A'
      };
      
      results.push(mainEntry);
    } else {
      // Nếu không tìm thấy tên cụ thể, dùng tiêu đề trang
      results.push({
        name: pageTitle,
        phone: phoneInfo.phones.length > 0 ? phoneInfo.phones[0] : 'N/A',
        email: emails.length > 0 ? emails[0] : 'N/A',
        hotline: phoneInfo.hotlines.length > 0 ? phoneInfo.hotlines[0] : 'N/A',
        zalo: phoneInfo.zaloNumbers.length > 0 ? phoneInfo.zaloNumbers[0] : 'N/A'
      });
    }
    
    // Case 2: Thêm email riêng nếu có nhiều email
    if (emails.length > 1) {
      for (let i = 1; i < emails.length; i++) {
        const newEntry = { ...results[0] };  // Sao chép thông tin chính
        newEntry.email = emails[i];
        results.push(newEntry);
      }
    }
    
    console.log(`Tìm thấy: ${businessNames.length} tên công ty, ${phoneInfo.phones.length} SĐT, ${emails.length} email, ${phoneInfo.hotlines.length} hotline, ${phoneInfo.zaloNumbers.length} Zalo`);
    return results;
  } catch (error) {
    console.error('Lỗi khi trích xuất thông tin doanh nghiệp:', error);
    return [];
  }
}

// Hàm chính để scrape dữ liệu
async function scrapeBusinessInfo() {
  console.log('Bắt đầu quá trình scraping...');
  scrapingProgress.current = 0;
  
  // Khởi tạo trình duyệt - tối ưu cho cloud environment
const browser = await puppeteer.launch({
  args: chromium.args,
  executablePath: await chromium.executablePath,
  headless: true
});
  
  try {
    const page = await browser.newPage();
    
    // Cài đặt User-Agent để trông như trình duyệt thông thường
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/100.0.4896.127 Safari/537.36');
    
    try {
      // Tắt tải hình ảnh để tăng tốc độ
      await page.setRequestInterception(true);
      page.on('request', (req) => {
        if (req.resourceType() === 'image') {
          req.abort();
        } else {
          req.continue();
        }
      });
    } catch (error) {
      console.warn('Không thể thiết lập request interception:', error.message);
    }
    
    // Truy cập trang web
    await page.goto(CONFIG.targetUrl, { timeout: CONFIG.pageTimeout, waitUntil: 'networkidle2' });
    console.log(`Đã truy cập ${CONFIG.targetUrl}`);
    
    // Thu thập thông tin
    const businessData = await extractBusinessInfo(page);
    scrapingProgress.businesses = businessData.length;
    
    console.log(`Đã thu thập được ${businessData.length} mục thông tin`);
    return businessData;
  } catch (error) {
    console.error('Lỗi trong quá trình scrape:', error);
    throw error;
  } finally {
    // Đóng trình duyệt
    await browser.close();
    console.log('Đã đóng trình duyệt, quá trình scrape hoàn tất');
  }
}

// Hàm xuất dữ liệu ra Excel
function exportToExcel(data, outputFile) {
  try {
    if (!data || !data.length) {
      console.log('Không có dữ liệu để xuất Excel');
      return;
    }
    
    // Xây dựng workbook
    const wb = xlsx.utils.book_new();
    
    // Chuẩn bị dữ liệu với 5 cột: Tên, SĐT, Email, Hotline, Zalo
    const formattedData = data.map(item => ({
      "Tên Công Ty": item.name || '',
      "Số Điện Thoại": item.phone || '',
      "Email": item.email ? item.email.replace('mailto:', '') : '',
      "Hotline": item.hotline || '',
      "Zalo": item.zalo || ''
    }));
    
    // Lọc các dòng không có dữ liệu hữu ích
    const filteredData = formattedData.filter(item => 
      item["Email"] !== 'N/A' || 
      item["Số Điện Thoại"] !== 'N/A' ||
      item["Hotline"] !== 'N/A' ||
      item["Zalo"] !== 'N/A'
    );
    
    // Tạo worksheet
    const ws = xlsx.utils.json_to_sheet(filteredData);
    
    // Đặt độ rộng cột
    const colWidths = [
      { wch: 40 }, // Tên Công Ty
      { wch: 20 }, // Số Điện Thoại
      { wch: 30 }, // Email
      { wch: 20 }, // Hotline
      { wch: 20 }  // Zalo
    ];
    ws['!cols'] = colWidths;
    
    // Thêm worksheet vào workbook
    xlsx.utils.book_append_sheet(wb, ws, "Thông Tin Công Ty");
    
    // Ghi file
    xlsx.writeFile(wb, outputFile);
    console.log(`Đã xuất dữ liệu ra file Excel: ${outputFile}`);
  } catch (error) {
    console.error('Lỗi khi xuất Excel:', error);
  }
}

// Hàm xuất dữ liệu ra CSV
function exportToCSV(data, outputFile) {
  if (!data || !data.length) {
    console.log('Không có dữ liệu để xuất CSV');
    return;
  }
  
  // Tạo header
  const headers = ['Tên Công Ty', 'Số Điện Thoại', 'Email', 'Hotline', 'Zalo'];
  
  // Tạo nội dung
  const rows = data.map(item => {
    return [
      escapeCsvValue(item.name || ''),
      escapeCsvValue(item.phone || ''),
      escapeCsvValue((item.email || '').replace('mailto:', '')),
      escapeCsvValue(item.hotline || ''),
      escapeCsvValue(item.zalo || '')
    ].join(',');
  });
  
  // Ghép header và content
  const csvContent = [headers.join(','), ...rows].join('\n');
  
  // Lưu file
  fs.writeFileSync(outputFile, csvContent);
  console.log(`Đã xuất dữ liệu ra file CSV: ${outputFile}`);
}

// Hàm xử lý giá trị CSV
function escapeCsvValue(value) {
  if (typeof value !== 'string') return value;
  if (value.includes(',') || value.includes('"') || value.includes('\n')) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

// Thiết lập Express server
const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// Route để trả về trang chủ
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// API để lấy trạng thái hiện tại
app.get('/api/status', (req, res) => {
  res.json({
    isScraping,
    progress: scrapingProgress,
    config: CONFIG
  });
});

// API để bắt đầu scraping
app.post('/api/scrape', async (req, res) => {
  try {
    console.log("Yêu cầu scrape nhận được:", req.body);
    
    // Cập nhật cấu hình từ request body
    const config = { ...CONFIG };
    
    // Xử lý từng trường riêng lẻ
    if (req.body.targetUrl) config.targetUrl = req.body.targetUrl;
    if (req.body.pagesToScrape) config.pagesToScrape = parseInt(req.body.pagesToScrape);
    if (req.body.pageTimeout) config.pageTimeout = parseInt(req.body.pageTimeout);
    
    // Xử lý selectors nếu có
    if (req.body['selectors.businessList']) {
      if (!config.selectors) config.selectors = {};
      config.selectors.businessList = req.body['selectors.businessList'];
      config.selectors.businessName = req.body['selectors.businessName'];
      config.selectors.businessPhone = req.body['selectors.businessPhone'];
      config.selectors.businessWebsite = req.body['selectors.businessWebsite'];
      config.selectors.nextPageButton = req.body['selectors.nextPageButton'];
    }
    
    // Bắt đầu scraping
    const scrapePromise = main(config);
    
    // Trả về trạng thái đã bắt đầu
    res.json({
      success: true,
      message: 'Đã bắt đầu scraping',
      isScraping: true
    });
    
    // Xử lý kết quả sau khi hoàn thành
    scrapePromise.catch(error => {
      console.error("Lỗi trong quá trình scrape:", error);
    });
  } catch (error) {
    console.error("Lỗi khi xử lý yêu cầu scrape:", error);
    res.status(500).json({
      success: false,
      message: `Lỗi: ${error.message}`
    });
  }
});

// API để lấy kết quả
app.get('/api/results', (req, res) => {
  res.json({
    success: true,
    data: scrapingResults
  });
});

// API để tải file Excel
app.get('/api/download/excel', (req, res) => {
  try {
    if (fs.existsSync(CONFIG.excelFile)) {
      res.download(CONFIG.excelFile);
    } else {
      res.status(404).json({ success: false, message: 'File Excel chưa được tạo' });
    }
  } catch (error) {
    console.error('Lỗi khi tải file Excel:', error);
    res.status(500).json({ success: false, message: `Lỗi khi tải file: ${error.message}` });
  }
});

// API để tải file CSV
app.get('/api/download/csv', (req, res) => {
  try {
    if (fs.existsSync(CONFIG.csvFile)) {
      res.download(CONFIG.csvFile);
    } else {
      res.status(404).json({ success: false, message: 'File CSV chưa được tạo' });
    }
  } catch (error) {
    console.error('Lỗi khi tải file CSV:', error);
    res.status(500).json({ success: false, message: `Lỗi khi tải file: ${error.message}` });
  }
});

// API để tải file JSON
app.get('/api/download/json', (req, res) => {
  try {
    if (fs.existsSync(CONFIG.outputFile)) {
      res.download(CONFIG.outputFile);
    } else {
      res.status(404).json({ success: false, message: 'File JSON chưa được tạo' });
    }
  } catch (error) {
    console.error('Lỗi khi tải file JSON:', error);
    res.status(500).json({ success: false, message: `Lỗi khi tải file: ${error.message}` });
  }
});

// Endpoint kiểm tra trạng thái server
app.get('/health', (req, res) => {
  res.status(200).json({ 
    status: 'ok', 
    time: new Date().toISOString(),
    environment: process.env.NODE_ENV || 'development'
  });
});

// Khởi động server
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server đang chạy tại http://localhost:${PORT}`);
  console.log(`Thời gian khởi động: ${new Date().toISOString()}`);
  console.log(`Môi trường: ${process.env.NODE_ENV || 'development'}`);
  console.log(`Thư mục output: ${OUTPUT_DIR}`);
});
