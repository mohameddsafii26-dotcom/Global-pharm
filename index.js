import express from 'express';
import cors from 'cors';
import Database from 'better-sqlite3';

const app = express();
app.use(cors());
app.use(express.json());
const db = new Database('pharmacy.db');
db.pragma('journal_mode = WAL');
db.exec(`
CREATE TABLE IF NOT EXISTS medicines (
 id INTEGER PRIMARY KEY AUTOINCREMENT, branch_id INTEGER NOT NULL DEFAULT 1,
 name TEXT NOT NULL, brand TEXT DEFAULT '', generic_name TEXT DEFAULT '',
 batch_no TEXT DEFAULT '', expiry_date TEXT DEFAULT '', purchase_price REAL NOT NULL DEFAULT 0,
 retail_price REAL NOT NULL DEFAULT 0, wholesale_price REAL NOT NULL DEFAULT 0,
 gst_percent REAL NOT NULL DEFAULT 0, stock INTEGER NOT NULL DEFAULT 0,
 min_stock INTEGER NOT NULL DEFAULT 5, barcode TEXT DEFAULT ''
);
CREATE TABLE IF NOT EXISTS invoices (
 id INTEGER PRIMARY KEY AUTOINCREMENT, invoice_no TEXT UNIQUE NOT NULL,
 branch_id INTEGER NOT NULL, sale_type TEXT NOT NULL, customer_name TEXT,
 customer_phone TEXT, subtotal REAL NOT NULL, discount REAL NOT NULL,
 taxable REAL NOT NULL, gst REAL NOT NULL, total REAL NOT NULL,
 payment_method TEXT NOT NULL, supply_type TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS invoice_items (
 id INTEGER PRIMARY KEY AUTOINCREMENT, invoice_id INTEGER NOT NULL,
 medicine_id INTEGER NOT NULL, medicine_name TEXT NOT NULL,
 quantity INTEGER NOT NULL, unit_price REAL NOT NULL, gst_percent REAL NOT NULL,
 line_total REAL NOT NULL, FOREIGN KEY(invoice_id) REFERENCES invoices(id)
);
`);
app.get('/api/health', (_,res)=>res.json({ok:true, service:'pharmacy-api'}));
app.get('/api/medicines', (req,res)=>{
 const branchId = Number(req.query.branchId || 1);
 res.json(db.prepare('SELECT * FROM medicines WHERE branch_id=? ORDER BY name').all(branchId));
});
app.post('/api/medicines', (req,res)=>{
 const m=req.body;
 if(!m.name || !String(m.name).trim()) return res.status(400).json({error:'Medicine name is required'});
 const stmt=db.prepare(`INSERT INTO medicines
 (branch_id,name,brand,generic_name,batch_no,expiry_date,purchase_price,retail_price,wholesale_price,gst_percent,stock,min_stock,barcode)
 VALUES (@branchId,@name,@brand,@genericName,@batchNo,@expiryDate,@purchasePrice,@retailPrice,@wholesalePrice,@gstPercent,@stock,@minStock,@barcode)`);
 const info=stmt.run({branchId:Number(m.branchId||1),name:String(m.name).trim(),brand:m.brand||'',genericName:m.genericName||'',batchNo:m.batchNo||'',expiryDate:m.expiryDate||'',purchasePrice:Number(m.purchasePrice||0),retailPrice:Number(m.retailPrice||0),wholesalePrice:Number(m.wholesalePrice||0),gstPercent:Number(m.gstPercent||0),stock:Number(m.stock||0),minStock:Number(m.minStock||5),barcode:m.barcode||''});
 res.status(201).json(db.prepare('SELECT * FROM medicines WHERE id=?').get(info.lastInsertRowid));
});
app.get('/api/invoices',(req,res)=>{
 res.json(db.prepare('SELECT * FROM invoices WHERE branch_id=? ORDER BY id DESC LIMIT 100').all(Number(req.query.branchId||1)));
});
const createBill=db.transaction((body)=>{
 const branchId=Number(body.branchId||1), saleType=body.saleType==='wholesale'?'wholesale':'retail';
 if(!Array.isArray(body.items)||!body.items.length) throw new Error('Add at least one medicine');
 let subtotal=0, gstTotal=0; const lines=[];
 for(const item of body.items){
  const qty=Math.floor(Number(item.quantity));
  if(!Number.isInteger(qty)||qty<1) throw new Error('Quantity must be at least 1');
  const med=db.prepare('SELECT * FROM medicines WHERE id=? AND branch_id=?').get(Number(item.medicineId),branchId);
  if(!med) throw new Error('Medicine not found in this branch');
  if(med.stock<qty) throw new Error(`Insufficient stock for ${med.name}. Available: ${med.stock}`);
  const price=saleType==='wholesale'?med.wholesale_price:med.retail_price;
  const base=price*qty, tax=base*med.gst_percent/100;
  subtotal+=base; gstTotal+=tax; lines.push({med,qty,price,base,tax});
 }
 const discount=Math.max(0,Math.min(Number(body.discount||0),subtotal));
 const taxable=subtotal-discount, ratio=subtotal?taxable/subtotal:1;
 gstTotal=lines.reduce((s,l)=>s+l.tax*ratio,0);
 const total=Number((taxable+gstTotal).toFixed(2));
 const interstate=(body.shopState||'Tamil Nadu')!==(body.placeOfSupplyState||'Tamil Nadu');
 const invoiceNo=`PH-${new Date().getFullYear()}-${Date.now()}`;
 const info=db.prepare(`INSERT INTO invoices(invoice_no,branch_id,sale_type,customer_name,customer_phone,subtotal,discount,taxable,gst,total,payment_method,supply_type,created_at)
 VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(invoiceNo,branchId,saleType,body.customerName||'Walk-in',body.customerPhone||'',subtotal,discount,taxable,gstTotal,total,body.paymentMethod||'cash',interstate?'IGST':'CGST+SGST',new Date().toISOString());
 const insertLine=db.prepare(`INSERT INTO invoice_items(invoice_id,medicine_id,medicine_name,quantity,unit_price,gst_percent,line_total) VALUES(?,?,?,?,?,?,?)`);
 for(const l of lines){
  db.prepare('UPDATE medicines SET stock=stock-? WHERE id=?').run(l.qty,l.med.id);
  insertLine.run(info.lastInsertRowid,l.med.id,l.med.name,l.qty,l.price,l.med.gst_percent,Number((l.base+l.tax*ratio).toFixed(2)));
 }
 return {id:info.lastInsertRowid,invoiceNo,subtotal:Number(subtotal.toFixed(2)),discount:Number(discount.toFixed(2)),taxable:Number(taxable.toFixed(2)),gst:Number(gstTotal.toFixed(2)),cgst:interstate?0:Number((gstTotal/2).toFixed(2)),sgst:interstate?0:Number((gstTotal/2).toFixed(2)),igst:interstate?Number(gstTotal.toFixed(2)):0,total};
});
app.post('/api/billing',(req,res)=>{
 try { res.status(201).json(createBill(req.body)); }
 catch(e){res.status(400).json({error:e.message});}
});
const port=4000;
app.listen(port,()=>console.log(`Pharmacy API listening on ${port}`));
