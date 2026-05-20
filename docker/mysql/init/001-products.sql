create table if not exists products (
  product_id varchar(64) primary key,
  description varchar(255) not null,
  ean varchar(32),
  sale_price decimal(10, 2) not null,
  quantity int not null,
  is_active boolean not null default true,
  updated_at timestamp(3) not null
);

insert into products (
  product_id,
  description,
  ean,
  sale_price,
  quantity,
  is_active,
  updated_at
) values
  (
    'P-001',
    'Dipirona 500mg',
    '7890000000011',
    12.50,
    7,
    true,
    '2026-05-16 20:00:01.000'
  ),
  (
    'P-002',
    'Paracetamol 750mg',
    '7890000000028',
    8.90,
    4,
    true,
    '2026-05-16 20:00:02.000'
  )
on duplicate key update
  description = values(description),
  ean = values(ean),
  sale_price = values(sale_price),
  quantity = values(quantity),
  is_active = values(is_active),
  updated_at = values(updated_at);
